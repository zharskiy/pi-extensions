import { LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import { relayName, repoNetworkLabels, repoNetworkName } from "../managed-network.ts";
import type { NetworkSummary, ProxyRoute, ProxyRouteRequest } from "../types.ts";
import { type EngineClient, segment } from "./engine-client.ts";

interface RelayInspect {
  Id: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
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

const RELAY_PREFIX = "pi-sandbox-relay-";

const RELAY_LISTEN_PORT = 3128;

const HOST_ALIAS = "host.lima.internal";

const REMOVAL_WAIT_MS = 10_000;

const NETWORK_HINT = "run pi sandbox gc";

const FOREIGN_NETWORK_HINT = "remove that network from the sandbox VM so the launcher can create its own";

const relayLabels = (hostPort: number, repoHash: string) => ({
  [LABELS.managed]: "true",
  [LABELS.relay]: "true",
  [LABELS.repoHash]: repoHash,
  [LABELS.relayPort]: String(hostPort),
});

export const createRelayOperations = (client: EngineClient) => {
  const inspectNetwork = async (name: string) => {
    const response = await client.call({ method: "GET", path: `/networks/${segment(name)}` }, [404]);

    return response.status === 404
      ? undefined
      : (JSON.parse(response.body.toString("utf8")) as NetworkInspect);
  };

  const assertManaged = (name: string, network: NetworkInspect) => {
    if (network.Internal !== true) {
      throw new LauncherError(`network ${name} exists but is not internal`, NETWORK_HINT);
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

  const startRelay = async (relayId: string) => {
    await client.call({ method: "POST", path: `/containers/${segment(relayId)}/start` }, [304]);
  };

  const dropRelay = async (relayId: string) => {
    await client.call(
      { method: "DELETE", path: `/containers/${segment(relayId)}`, query: { force: true } },
      [404, 409],
    );

    await client
      .call(
        {
          method: "POST",
          path: `/containers/${segment(relayId)}/wait`,
          query: { condition: "removed" },
          timeoutMs: REMOVAL_WAIT_MS,
        },
        [404, 409],
      )
      .catch(() => undefined);
  };

  const createRelay = async (request: ProxyRouteRequest, network: string) => {
    const created = await client.json<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      query: { name: relayName(request.repoHash) },
      json: {
        Image: request.imageId,
        Entrypoint: ["socat"],
        Cmd: [`TCP-LISTEN:${RELAY_LISTEN_PORT},fork,reuseaddr`, `TCP:${HOST_ALIAS}:${request.hostPort}`],
        Labels: relayLabels(request.hostPort, request.repoHash),
        HostConfig: {
          NetworkMode: "bridge",
          Init: true,
          ReadonlyRootfs: true,
          AutoRemove: true,
        },
      },
    });

    await attach(network, created.Id);

    await startRelay(created.Id);
  };

  const ensureRelay = async (request: ProxyRouteRequest, network: string) => {
    const relay = await inspectRelay(relayName(request.repoHash));

    if (relay !== undefined && matches(relay, relayLabels(request.hostPort, request.repoHash))) {
      if ((await inspectNetwork(network))?.Containers?.[relay.Id] === undefined) {
        await attach(network, relay.Id);
      }

      if (relay.State?.Running !== true) {
        await startRelay(relay.Id);
      }

      return;
    }

    if (relay !== undefined) {
      await dropRelay(relay.Id);
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

  const removeRepoNetwork = async (repoHash: string) => {
    const name = repoNetworkName(repoHash);
    const network = await inspectNetwork(name);

    if (network === undefined || network.Labels?.[LABELS.managed] !== "true") {
      return false;
    }

    const attached = Object.entries(network.Containers ?? {});

    if (attached.some(([, entry]) => !(entry.Name ?? "").startsWith(RELAY_PREFIX))) {
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
