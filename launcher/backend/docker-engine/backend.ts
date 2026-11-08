import { existsSync } from "node:fs";
import { isIPv4 } from "node:net";
import { type CommandRunner, errorMessage, LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import { removeWithNetworkCleanup } from "../managed-network.ts";
import type {
  Backend,
  BackendCapabilities,
  ContainerSpec,
  Detection,
  RemoveContainerOptions,
} from "../types.ts";
import { containerBody, type EngineContainer, labelFilters, summaryOf } from "./container-body.ts";
import { createEngineClient, engineError, messageOf, segment } from "./engine-client.ts";
import { runExec } from "./exec-session.ts";
import { createImageOperations } from "./images.ts";
import { createRelayOperations } from "./relay.ts";
import { colimaProfileOf } from "./socket.ts";
import { createVolumeOperations } from "./volumes.ts";

export interface DockerEngineOptions {
  socketPath: string;
  runner: CommandRunner;
  home: string;
  platform?: NodeJS.Platform;
}

interface EngineInfo {
  OperatingSystem?: string;
  SecurityOptions?: string[] | null;
}

interface BridgeInspect {
  IPAM?: { Config?: Array<{ Gateway?: string }> | null };
}

interface EngineVersion {
  Version?: string;
  ApiVersion?: string;
  Os?: string;
  Arch?: string;
}

const LIMA_HOST = "host.lima.internal";

const DOCKER_HOST_ALIAS = "host.docker.internal";

const STOP_TIMEOUT_SECONDS = 5;

const DOCKER_DESKTOP = "Docker Desktop";

const MISSING_BIND_SOURCE = /bind source path does not exist: (.+)$/;

const unsharedSource = (body: Buffer) => {
  const path = MISSING_BIND_SOURCE.exec(messageOf(body))?.[1];

  return path !== undefined && existsSync(path) ? path : undefined;
};

export const createDockerEngineBackend = (options: DockerEngineOptions): Backend => {
  const client = createEngineClient(options.socketPath);
  const colimaProfile = colimaProfileOf(options.socketPath, options.home);
  const images = createImageOperations(client, options.runner);
  const volumes = createVolumeOperations(client);
  const hostAlias = colimaProfile === undefined ? DOCKER_HOST_ALIAS : LIMA_HOST;
  const native = (options.platform ?? process.platform) === "linux" && colimaProfile === undefined;

  const findBridgeGateway = async () => {
    const info = await client.json<EngineInfo>({ method: "GET", path: "/info" }).catch(() => undefined);
    const rootless = (info?.SecurityOptions ?? []).some((option) => option.includes("rootless"));

    if (info === undefined || rootless || (info.OperatingSystem ?? "").includes(DOCKER_DESKTOP)) {
      return undefined;
    }

    const bridge = await client
      .json<BridgeInspect>({ method: "GET", path: "/networks/bridge" })
      .catch(() => undefined);

    return (bridge?.IPAM?.Config ?? [])
      .map((entry) => entry.Gateway ?? "")
      .find((address) => isIPv4(address));
  };

  const bridgeGateway = { found: undefined as Promise<string | undefined> | undefined };

  const nativeGateway = () => {
    if (!native) {
      return Promise.resolve(undefined);
    }

    bridgeGateway.found = bridgeGateway.found ?? findBridgeGateway();

    return bridgeGateway.found;
  };

  const relay = createRelayOperations(client, hostAlias, nativeGateway);

  const capabilities: BackendCapabilities = {
    singleFileMount: true,
    sshAgent: colimaProfile !== undefined,
  };

  const version = () => client.json<EngineVersion>({ method: "GET", path: "/version" });

  const detect = async (): Promise<Detection> => {
    try {
      await client.call({ method: "GET", path: "/_ping" });

      return { available: true, version: (await version()).Version };
    } catch (error) {
      return { available: false, reason: errorMessage(error) };
    }
  };

  const colimaAgentSocket = async (profile: string) => {
    try {
      const result = await options.runner.run("colima", [
        "ssh",
        "--profile",
        profile,
        "--",
        "printenv",
        "SSH_AUTH_SOCK",
      ]);
      const socket = result.stdout.trim();

      return result.code === 0 && socket !== "" ? socket : undefined;
    } catch {
      return undefined;
    }
  };

  const hostAgentSocket = async () => {
    const socket = colimaProfile === undefined ? undefined : await colimaAgentSocket(colimaProfile);

    if (socket === undefined) {
      throw new LauncherError(
        "ssh agent forwarding needs a Colima VM started with an ssh agent",
        "start it with colima start --profile pi-sandbox --ssh-agent, or set ssh.agent to false",
      );
    }

    return socket;
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
    const agentSocket = spec.sshAgent === undefined ? undefined : await hostAgentSocket();
    const response = await client.call(
      {
        method: "POST",
        path: "/containers/create",
        query: { name: spec.name },
        json: containerBody(spec, agentSocket),
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
          colimaProfile === undefined
            ? `share ${path} in the runtime's file sharing settings`
            : "run pi sandbox doctor; its vm shares line names the command",
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
    const base = { socket: options.socketPath, profile: colimaProfile ?? "none" };

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
    name: "colima",
    capabilities,
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
    exportVolume: volumes.exportVolume,
    importVolume: volumes.importVolume,
    prepareProxyRoute: relay.prepareProxyRoute,
    pruneNetworks: relay.pruneNetworks,
    proxyListenHosts: async () => {
      const gateway = await nativeGateway();

      return gateway === undefined ? [] : [gateway];
    },
    status,
  };
};
