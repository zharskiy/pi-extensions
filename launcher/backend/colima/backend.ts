import { existsSync } from "node:fs";
import { type CommandRunner, errorMessage, LauncherError } from "../../shared/index.ts";
import { installIdOf } from "../install.ts";
import { LABELS } from "../labels.ts";
import type { Backend, ContainerSpec, Detection } from "../types.ts";
import {
  containerBody,
  type EngineContainer,
  type EngineInspect,
  inspectOf,
  labelFilters,
  summaryOf,
} from "./container-body.ts";
import {
  createEngineClient,
  ENGINE_TIMEOUTS,
  EngineTimeout,
  type EngineTimeouts,
  engineError,
  messageOf,
  segment,
} from "./engine-client.ts";
import { demultiplexer, runExec } from "./exec-session.ts";
import { createImageOperations } from "./images.ts";
import { createNetworkOperations } from "./networks.ts";
import { ENGINE_PROFILE, engineSocketPath } from "./profile.ts";
import { createRelayOperations } from "./relay.ts";
import { createColimaVm } from "./vm.ts";
import { createVolumeOperations } from "./volumes.ts";

export interface ColimaBackendOptions {
  home: string;
  stateDir: string;
  runner: CommandRunner;
  socketPath?: string;
  timeouts?: EngineTimeouts;
}

interface EngineVersion {
  Version?: string;
  ApiVersion?: string;
  Os?: string;
  Arch?: string;
}

const STOP_TIMEOUT_SECONDS = 5;

const RELAY_REMOVAL_MS = 10_000;

const MISSING_BIND_SOURCE = /bind source path does not exist: (.+)$/;

const unsharedSource = (body: Buffer) => {
  const path = MISSING_BIND_SOURCE.exec(messageOf(body))?.[1];

  return path !== undefined && existsSync(path) ? path : undefined;
};

export const createColimaBackend = (options: ColimaBackendOptions): Backend => {
  const socket = () => options.socketPath ?? engineSocketPath(options.home);
  const timeouts = options.timeouts ?? ENGINE_TIMEOUTS;
  const client = createEngineClient(socket, timeouts);
  const images = createImageOperations(client, options.runner);
  const install = installIdOf(options.stateDir);
  const owned = { [LABELS.managed]: "true", [LABELS.install]: install };
  const volumes = createVolumeOperations(client, install);
  const networks = createNetworkOperations(client, install);
  const relay = createRelayOperations(client, install, networks, (id) =>
    removeContainer(id, Math.min(RELAY_REMOVAL_MS, timeouts.callMs)),
  );

  const version = () => client.json<EngineVersion>({ method: "GET", path: "/version" });

  const detect = async (): Promise<Detection> => {
    try {
      await client.call({ method: "GET", path: "/_ping" });

      return { available: true };
    } catch (error) {
      return { available: false, reason: errorMessage(error) };
    }
  };

  const listContainers = async (labels: Record<string, string>) => {
    const containers = await client.json<EngineContainer[]>({
      method: "GET",
      path: "/containers/json",
      query: { all: true, filters: labelFilters(labels) },
    });

    return containers.map(summaryOf);
  };

  const createContainer = async (spec: ContainerSpec) => {
    const response = await client.call(
      {
        method: "POST",
        path: "/containers/create",
        query: { name: spec.name },
        json: containerBody({ ...spec, labels: { ...spec.labels, ...owned } }),
      },
      [400, 409],
    );

    if (response.status === 409) {
      throw new LauncherError(`unexpected name clash: container name ${spec.name} is already in use`);
    }

    if (response.status === 400) {
      const path = unsharedSource(response.body);

      if (path !== undefined) {
        throw new LauncherError(
          `the sandbox VM does not share ${path}`,
          "run pinata doctor; its vm shares line names the folders the VM lacks",
        );
      }

      throw engineError({ method: "POST", path: "/containers/create" }, response);
    }

    return { id: (JSON.parse(response.body.toString("utf8")) as { Id: string }).Id };
  };

  const startContainer = async (id: string) => {
    await client.call({ method: "POST", path: `/containers/${segment(id)}/start` }, [304]);
  };

  const stopContainer = async (id: string, timeoutSeconds = STOP_TIMEOUT_SECONDS) => {
    await client.call(
      {
        method: "POST",
        path: `/containers/${segment(id)}/stop`,
        query: { t: timeoutSeconds },
        timeoutMs: timeouts.callMs + timeoutSeconds * 1000,
      },
      [304, 404],
    );
  };

  const inspectContainer = async (id: string) => {
    const response = await client.call({ method: "GET", path: `/containers/${segment(id)}/json` }, [404]);

    if (response.status === 404) {
      return undefined;
    }

    return inspectOf(JSON.parse(response.body.toString("utf8")) as EngineInspect);
  };

  const containerLogs = async (id: string, lines: number) => {
    const response = await client.call(
      {
        method: "GET",
        path: `/containers/${segment(id)}/logs`,
        query: { stdout: true, stderr: true, tail: lines },
      },
      [404],
    );

    if (response.status === 404) {
      return "";
    }

    const chunks: Buffer[] = [];

    demultiplexer({ stdout: chunks, stderr: chunks }, (target, data) => target.push(data))(response.body);

    return Buffer.concat(chunks).toString("utf8");
  };

  const removeContainer = async (id: string, timeoutMs?: number) => {
    await client.call(
      { method: "DELETE", path: `/containers/${segment(id)}`, query: { force: true, v: true }, timeoutMs },
      [404, 409],
    );

    await client
      .call(
        {
          method: "POST",
          path: `/containers/${segment(id)}/wait`,
          query: { condition: "removed" },
          timeoutMs,
        },
        [404],
      )
      .catch((error: unknown) => {
        throw error instanceof EngineTimeout
          ? new EngineTimeout(
              `container ${id} is still being removed by the engine: ${error.message}`,
              "the next pi start removes what is left",
            )
          : error;
      });
  };

  const status = async () => {
    const base = { socket: socket(), profile: ENGINE_PROFILE };

    try {
      const engine = await version();

      return {
        ...base,
        engine: engine.Version ?? "unknown",
        api: engine.ApiVersion ?? "unknown",
        platform: `${engine.Os}/${engine.Arch}`,
      };
    } catch (error) {
      return { ...base, engine: `unreachable: ${errorMessage(error)}` };
    }
  };

  return {
    vm: createColimaVm({ home: options.home, stateDir: options.stateDir, runner: options.runner, detect }),
    detect,
    pullImage: images.pullImage,
    resolveImage: images.resolveImage,
    buildImage: images.buildImage,
    listImages: images.listImages,
    removeImage: images.removeImage,
    findContainers: (labels) => listContainers({ ...labels, ...owned }),
    listOtherInstallSessions: async () => {
      const sessions = await listContainers({ [LABELS.managed]: "true", [LABELS.role]: "agent" });

      return sessions.filter(
        (session) => session.state === "running" && session.labels[LABELS.install] !== install,
      );
    },
    createContainer,
    startContainer,
    stopContainer,
    removeContainer: (id) => removeContainer(id),
    inspectContainer,
    containerLogs,
    exec: (spec, io) => runExec(client, spec, io),
    ensureVolume: volumes.ensureVolume,
    listVolumes: volumes.listVolumes,
    removeVolume: volumes.removeVolume,
    prepareRelay: relay.prepareRelay,
    prepareNetwork: networks.prepareNetwork,
    removeNetwork: networks.removeNetwork,
    status,
  };
};
