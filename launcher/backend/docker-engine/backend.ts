import { type CommandRunner, errorMessage, LauncherError } from "../../shared/index.ts";
import type { Backend, BackendCapabilities, ContainerSpec, Detection } from "../types.ts";
import { containerBody, type EngineContainer, labelFilters, summaryOf } from "./container-body.ts";
import { createEngineClient, segment } from "./engine-client.ts";
import { runExec } from "./exec-session.ts";
import { createImageOperations } from "./images.ts";
import { createRelayOperations } from "./relay.ts";
import { colimaProfileOf } from "./socket.ts";
import { createVolumeOperations } from "./volumes.ts";

export interface DockerEngineOptions {
  socketPath: string;
  runner: CommandRunner;
  home: string;
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

export const createDockerEngineBackend = (options: DockerEngineOptions): Backend => {
  const client = createEngineClient(options.socketPath);
  const colimaProfile = colimaProfileOf(options.socketPath, options.home);
  const images = createImageOperations(client, options.runner);
  const volumes = createVolumeOperations(client);
  const hostAlias = colimaProfile === undefined ? DOCKER_HOST_ALIAS : LIMA_HOST;
  const relay = createRelayOperations(client, hostAlias);

  const capabilities: BackendCapabilities = {
    singleFileMount: true,
    sshAgent: colimaProfile !== undefined,
    internalNetwork: true,
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
      [409],
    );

    if (response.status === 409) {
      throw new LauncherError(`container name ${spec.name} is already in use`, "run pi sandbox reset");
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

  const removeContainer = async (id: string) => {
    await client.call(
      { method: "DELETE", path: `/containers/${segment(id)}`, query: { force: true } },
      [404],
    );
  };

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
    removeVolume: volumes.removeVolume,
    exportVolume: volumes.exportVolume,
    importVolume: volumes.importVolume,
    prepareProxyRoute: relay.prepareProxyRoute,
    status,
  };
};
