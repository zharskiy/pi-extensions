import { LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import { pruneCandidates, repoNetworkLabels, repoNetworkName } from "../managed-network.ts";
import type { ProxyRoute, ProxyRouteRequest } from "../types.ts";
import { type EngineClient, segment } from "./engine-client.ts";

interface RelayInspect {
  Id: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
}

interface NetworkInspect {
  Internal?: boolean;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, { Name?: string; IPv4Address?: string }> | null;
}

interface NetworkSummary {
  Name?: string;
}

const RELAY_PREFIX = "pi-sandbox-relay-";

const RELAY_LISTEN_PORT = 3128;

const DOCKER_HOST_ALIAS = "host.docker.internal";

const HOST_GATEWAY = "host-gateway";

const networkHint = (name: string) =>
  `remove it (docker network rm ${name}) so the launcher can create its own`;

const relayName = (policyHash: string) => `${RELAY_PREFIX}${policyHash.slice(0, 8)}`;

const relayLabels = (hostPort: number, policyHash: string) => ({
  [LABELS.managed]: "true",
  [LABELS.relay]: "true",
  [LABELS.relayPort]: String(hostPort),
  [LABELS.proxyPolicyHash]: policyHash,
});

export const createRelayOperations = (
  client: EngineClient,
  hostAlias: string,
  nativeGateway: () => Promise<string | undefined>,
) => {
  const inspectNetwork = async (name: string) => {
    const response = await client.call({ method: "GET", path: `/networks/${segment(name)}` }, [404]);

    return response.status === 404
      ? undefined
      : (JSON.parse(response.body.toString("utf8")) as NetworkInspect);
  };

  const assertManaged = (name: string, network: NetworkInspect) => {
    if (network.Internal !== true) {
      throw new LauncherError(`network ${name} exists but is not internal`, networkHint(name));
    }

    if (network.Labels?.[LABELS.managed] !== "true") {
      throw new LauncherError(`network ${name} exists but is not managed by pi-sandbox`, networkHint(name));
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

  const connect = async (network: string, containerId: string) => {
    await client.call({
      method: "POST",
      path: `/networks/${segment(network)}/connect`,
      json: { Container: containerId },
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

  const createRelay = async (hostPort: number, policyHash: string, imageId: string) => {
    const gateway = (await nativeGateway()) ?? HOST_GATEWAY;
    const created = await client.json<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      query: { name: relayName(policyHash) },
      json: {
        Image: imageId,
        Entrypoint: ["socat"],
        Cmd: [`TCP-LISTEN:${RELAY_LISTEN_PORT},fork,reuseaddr`, `TCP:${hostAlias}:${hostPort}`],
        Labels: { ...relayLabels(hostPort, policyHash), [LABELS.relayImage]: imageId },
        HostConfig: {
          NetworkMode: "bridge",
          ExtraHosts: [`${DOCKER_HOST_ALIAS}:${gateway}`],
          Init: true,
          ReadonlyRootfs: true,
        },
      },
    });

    await startRelay(created.Id);

    return created.Id;
  };

  const managedNetworks = () =>
    client.json<NetworkSummary[]>({
      method: "GET",
      path: "/networks",
      query: { filters: JSON.stringify({ label: [`${LABELS.managed}=true`] }) },
    });

  const servesOthers = async (relayId: string, ownNetwork: string) => {
    const names = (await managedNetworks())
      .map((network) => network.Name ?? "")
      .filter((name) => name !== ownNetwork);
    const inspected = await Promise.all(names.map(inspectNetwork));

    return inspected.some((network) => {
      const attached = Object.entries(network?.Containers ?? {});

      return (
        attached.some(([id]) => id === relayId) &&
        attached.some(([, entry]) => !(entry.Name ?? "").startsWith(RELAY_PREFIX))
      );
    });
  };

  const keptNotice = (name: string, relay: RelayInspect, hostPort: number) =>
    `the egress relay ${name} still forwards to proxy port ${relay.Config?.Labels?.[LABELS.relayPort] ?? "unknown"}, not ${hostPort}; it is kept because sandboxes of other repositories use it, so egress may fail until they exit and it is replaced`;

  const ensureRelay = async (hostPort: number, policyHash: string, imageId: string, network: string) => {
    const name = relayName(policyHash);
    const relay = await inspectRelay(name);

    if (relay !== undefined && matches(relay, relayLabels(hostPort, policyHash))) {
      if (relay.State?.Running !== true) {
        await startRelay(relay.Id);
      }

      return { relayId: relay.Id, notices: [] };
    }

    if (relay !== undefined && (await servesOthers(relay.Id, network))) {
      return { relayId: relay.Id, notices: [keptNotice(name, relay, hostPort)] };
    }

    if (relay !== undefined) {
      await client.call(
        { method: "DELETE", path: `/containers/${segment(relay.Id)}`, query: { force: true } },
        [404],
      );
    }

    return { relayId: await createRelay(hostPort, policyHash, imageId), notices: [] };
  };

  const relayAddress = async (network: string, relayId: string) => {
    const before = await inspectNetwork(network);

    if (before?.Containers?.[relayId] === undefined) {
      await connect(network, relayId);
    }

    const address = (await inspectNetwork(network))?.Containers?.[relayId]?.IPv4Address?.split("/")[0];

    if (address === undefined || address === "") {
      throw new LauncherError(`relay ${relayId.slice(0, 12)} has no address on network ${network}`);
    }

    return address;
  };

  const prepareProxyRoute = async ({ hostPort, repoHash, relay }: ProxyRouteRequest): Promise<ProxyRoute> => {
    const network = repoNetworkName(repoHash);

    await ensureNetwork(network, repoHash);

    const { relayId, notices } = await ensureRelay(hostPort, relay.policyHash, relay.imageId, network);

    return {
      network: { kind: "internal", name: network },
      address: `${await relayAddress(network, relayId)}:${RELAY_LISTEN_PORT}`,
      ...(notices.length === 0 ? {} : { notices }),
    };
  };

  const removeNetwork = async (name: string) => {
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

  const pruneNetworks = async (keepRepoHashes: string[]) => {
    const listed = await managedNetworks();
    const candidates = pruneCandidates(
      listed.map((network) => network.Name ?? ""),
      keepRepoHashes,
    );
    const removed = await Promise.all(candidates.map(removeNetwork));

    return candidates.filter((_name, index) => removed[index]);
  };

  return { prepareProxyRoute, removeNetwork, pruneNetworks };
};
