import { LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import { RELAY_PREFIX, relayName, repoNetworkLabels, repoNetworkName } from "../managed-network.ts";
import type { NetworkSummary, ProxyRoute, ProxyRouteRequest } from "../types.ts";
import { confined, type EngineContainer, labelFilters } from "./container-body.ts";
import { type EngineClient, EngineTimeout, segment } from "./engine-client.ts";
import { VM_HOST_ALIAS } from "./profile.ts";

interface RelayInspect {
  Id: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

interface NetworkInspect {
  Internal?: boolean;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, { Name?: string }> | null;
}

interface EngineNetwork {
  Name?: string;
  Labels?: Record<string, string> | null;
}

const PROXY_ALIAS = "pi-sandbox-proxy";

const RELAY_LISTEN_PORT = 3128;

const RELAY_PIDS_LIMIT = 1024;

const FOREIGN_NETWORK_HINT = "remove that network from the sandbox VM so the launcher can create its own";

const relayLabels = (hostPort: number, repoHash: string) => ({
  [LABELS.managed]: "true",
  [LABELS.relay]: "true",
  [LABELS.repoHash]: repoHash,
  [LABELS.relayPort]: String(hostPort),
});

const stillRemoving = (name: string) =>
  new LauncherError(
    `relay ${name} is still being removed by the engine, so its replacement cannot be created`,
    "run pi again in a minute",
  );

export const createRelayOperations = (
  client: EngineClient,
  removeContainer: (id: string) => Promise<void>,
) => {
  const inspectNetwork = async (name: string) => {
    const response = await client.call({ method: "GET", path: `/networks/${segment(name)}` }, [404]);

    return response.status === 404
      ? undefined
      : (JSON.parse(response.body.toString("utf8")) as NetworkInspect);
  };

  const assertManaged = (name: string, network: NetworkInspect) => {
    if (network.Internal !== true) {
      throw new LauncherError(`network ${name} exists but is not internal`, FOREIGN_NETWORK_HINT);
    }

    if (network.Labels?.[LABELS.managed] !== "true") {
      throw new LauncherError(
        `network ${name} exists but is not managed by pi-sandbox`,
        FOREIGN_NETWORK_HINT,
      );
    }
  };

  const ensureNetwork = async (name: string, repoHash: string) => {
    const existing = await inspectNetwork(name);

    if (existing !== undefined) {
      assertManaged(name, existing);

      return;
    }

    await client.call({
      method: "POST",
      path: "/networks/create",
      json: {
        Name: name,
        Driver: "bridge",
        Internal: true,
        CheckDuplicate: true,
        Labels: repoNetworkLabels(repoHash),
      },
    });
  };

  const attach = async (network: string, containerId: string) => {
    await client.call({
      method: "POST",
      path: `/networks/${segment(network)}/connect`,
      json: { Container: containerId, EndpointConfig: { Aliases: [PROXY_ALIAS] } },
    });
  };

  const inspectRelay = async (name: string) => {
    const response = await client.call({ method: "GET", path: `/containers/${segment(name)}/json` }, [404]);

    return response.status === 404 ? undefined : (JSON.parse(response.body.toString("utf8")) as RelayInspect);
  };

  const matches = (relay: RelayInspect, labels: Record<string, string>) =>
    Object.entries(labels).every(([key, value]) => relay.Config?.Labels?.[key] === value);

  const usable = (relay: RelayInspect | undefined, request: ProxyRouteRequest, network: string) =>
    relay !== undefined &&
    relay.State?.Running === true &&
    matches(relay, relayLabels(request.hostPort, request.repoHash)) &&
    relay.NetworkSettings?.Networks?.[network] !== undefined;

  const createRelay = async (request: ProxyRouteRequest, network: string) => {
    const name = relayName(request.repoHash);
    const response = await client.call(
      {
        method: "POST",
        path: "/containers/create",
        query: { name },
        json: {
          Image: request.imageId,
          Entrypoint: ["socat"],
          Cmd: [`TCP-LISTEN:${RELAY_LISTEN_PORT},fork,reuseaddr`, `TCP:${VM_HOST_ALIAS}:${request.hostPort}`],
          Labels: relayLabels(request.hostPort, request.repoHash),
          HostConfig: {
            NetworkMode: "bridge",
            Init: true,
            ReadonlyRootfs: true,
            AutoRemove: true,
            ...confined(RELAY_PIDS_LIMIT),
          },
        },
      },
      [409],
    );

    if (response.status === 409) {
      throw stillRemoving(name);
    }

    const created = JSON.parse(response.body.toString("utf8")) as { Id: string };

    await attach(network, created.Id);

    await client.call({ method: "POST", path: `/containers/${segment(created.Id)}/start` }, [304]);
  };

  const ensureRelay = async (request: ProxyRouteRequest, network: string) => {
    const name = relayName(request.repoHash);
    const relay = await inspectRelay(name);

    if (usable(relay, request, network)) {
      return;
    }

    if (relay !== undefined) {
      await removeContainer(relay.Id).catch((error: unknown) => {
        throw error instanceof EngineTimeout ? stillRemoving(name) : error;
      });
    }

    await createRelay(request, network);
  };

  const prepareProxyRoute = async (request: ProxyRouteRequest): Promise<ProxyRoute> => {
    const network = repoNetworkName(request.repoHash);

    await ensureNetwork(network, request.repoHash);

    await ensureRelay(request, network);

    return {
      network: { kind: "internal", name: network },
      address: `${PROXY_ALIAS}:${RELAY_LISTEN_PORT}`,
    };
  };

  const listNetworks = async (): Promise<NetworkSummary[]> => {
    const listed = await client.json<EngineNetwork[]>({
      method: "GET",
      path: "/networks",
      query: { filters: JSON.stringify({ label: [`${LABELS.managed}=true`] }) },
    });

    return listed.map((network) => ({ name: network.Name ?? "", labels: network.Labels ?? {} }));
  };

  const sandboxesOf = async (repoHash: string) => {
    const containers = await client.json<EngineContainer[]>({
      method: "GET",
      path: "/containers/json",
      query: { all: true, filters: labelFilters({ [LABELS.repoHash]: repoHash }) },
    });

    return containers.filter((container) => container.Labels?.[LABELS.relay] !== "true");
  };

  const removeRepoNetwork = async (repoHash: string) => {
    const name = repoNetworkName(repoHash);
    const network = await inspectNetwork(name);

    if (network === undefined || network.Labels?.[LABELS.managed] !== "true") {
      return false;
    }

    const attached = Object.entries(network.Containers ?? {});

    if (
      attached.some(([, entry]) => !(entry.Name ?? "").startsWith(RELAY_PREFIX)) ||
      (await sandboxesOf(repoHash)).length > 0
    ) {
      return false;
    }

    await Promise.all(
      attached.map(([containerId]) =>
        client.call(
          {
            method: "POST",
            path: `/networks/${segment(name)}/disconnect`,
            json: { Container: containerId, Force: true },
          },
          [404],
        ),
      ),
    );

    const response = await client.call({ method: "DELETE", path: `/networks/${segment(name)}` }, [404, 409]);

    return response.status < 300;
  };

  return { prepareProxyRoute, listNetworks, removeRepoNetwork };
};
