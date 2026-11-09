import { existsSync } from "node:fs";
import { type CommandRunner, errorMessage, LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import { removeWithNetworkCleanup } from "../managed-network.ts";
import type { Backend, ContainerSpec, Detection, RemoveContainerOptions } from "../types.ts";
import { containerBody, type EngineContainer, labelFilters, summaryOf } from "./container-body.ts";
import { createEngineClient, engineError, messageOf, segment } from "./engine-client.ts";
import { runExec } from "./exec-session.ts";
import { createImageOperations } from "./images.ts";
import { ENGINE_PROFILE, engineSocketPath } from "./profile.ts";
import { createRelayOperations } from "./relay.ts";
import { createColimaVm } from "./vm.ts";
import { createVolumeOperations } from "./volumes.ts";

export interface ColimaBackendOptions {
  home: string;
  stateDir: string;
  runner: CommandRunner;
  socketPath?: string;
}

interface EngineVersion {
  Version?: string;
  ApiVersion?: string;
  Os?: string;
  Arch?: string;
}

const STOP_TIMEOUT_SECONDS = 5;

const MISSING_BIND_SOURCE = /bind source path does not exist: (.+)$/;

const unsharedSource = (body: Buffer) => {
  const path = MISSING_BIND_SOURCE.exec(messageOf(body))?.[1];

  return path !== undefined && existsSync(path) ? path : undefined;
};

export const createColimaBackend = (options: ColimaBackendOptions): Backend => {
  const socket = () => options.socketPath ?? engineSocketPath(options.home);
  const client = createEngineClient(socket);
  const images = createImageOperations(client, options.runner);
  const volumes = createVolumeOperations(client);
  const relay = createRelayOperations(client);

  const version = () => client.json<EngineVersion>({ method: "GET", path: "/version" });

  const detect = async (): Promise<Detection> => {
    try {
      await client.call({ method: "GET", path: "/_ping" });

      return { available: true, version: (await version()).Version };
    } catch (error) {
      return { available: false, reason: errorMessage(error) };
    }
  };

  const findContainers = async (labels: Record<string, string>) => {
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
        json: containerBody(spec),
      },
      [400, 409],
    );

    if (response.status === 409) {
      throw new LauncherError(`container name ${spec.name} is already in use`, "run pi sandbox reset");
    }

    if (response.status === 400) {
      const path = unsharedSource(response.body);

      if (path !== undefined) {
        throw new LauncherError(
          `the sandbox VM does not share ${path}`,
          "run pi sandbox doctor; its vm shares line names the command",
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
      { method: "POST", path: `/containers/${segment(id)}/stop`, query: { t: timeoutSeconds } },
      [304],
    );
  };

  const repoHashOf = async (id: string) => {
    const response = await client.call({ method: "GET", path: `/containers/${segment(id)}/json` }, [404]);

    if (response.status === 404) {
      return undefined;
    }

    const inspected = JSON.parse(response.body.toString("utf8")) as {
      Config?: { Labels?: Record<string, string> | null };
    };

    return inspected.Config?.Labels?.[LABELS.repoHash];
  };

  const deleteContainer = async (id: string) => {
    await client.call(
      { method: "DELETE", path: `/containers/${segment(id)}`, query: { force: true } },
      [404],
    );
  };

  const removeContainer = (id: string, options: RemoveContainerOptions = {}) =>
    removeWithNetworkCleanup(
      { repoHashOf, remove: deleteContainer, findContainers, removeNetwork: relay.removeNetwork },
      id,
      options,
    );

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
    findContainers,
    createContainer,
    startContainer,
    stopContainer,
    removeContainer,
    exec: (spec, io) => runExec(client, spec, io),
    ensureVolume: volumes.ensureVolume,
    listVolumes: volumes.listVolumes,
    removeVolume: volumes.removeVolume,
    prepareProxyRoute: relay.prepareProxyRoute,
    pruneNetworks: relay.pruneNetworks,
    status,
  };
};
