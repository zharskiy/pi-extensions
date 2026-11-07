import { LauncherError } from "../../shared/index.ts";
import type { ProxyRoute } from "../types.ts";
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

const RELAY_NETWORK = "pi-sandbox";

const REPO_LABEL = "pi-sandbox.repo-hash";

const SHORT_REPO_HASH = 12;

const RELAY_PREFIX = "pi-sandbox-relay-";

const MANAGED_LABEL = "pi-sandbox.managed";

const RELAY_LABEL = "pi-sandbox.relay";

const RELAY_PORT_LABEL = "pi-sandbox.relay-port";

const POLICY_LABEL = "pi-sandbox.proxy-policy-hash";

const IMAGE_LABEL = "pi-sandbox.relay-image";

const RELAY_LISTEN_PORT = 3128;

const DOCKER_HOST_GATEWAY = "host.docker.internal:host-gateway";

const networkHint = (name: string) =>
  `remove it (docker network rm ${name}) so the launcher can create its own`;

const PRUNABLE_NETWORK = /^pi-sandbox(?:-([0-9a-f]{12}))?$/;

const repoNetworkName = (repoHash: string | undefined) =>
  repoHash === undefined ? RELAY_NETWORK : `${RELAY_NETWORK}-${repoHash.slice(0, SHORT_REPO_HASH)}`;

const relayName = (policyHash: string) => `${RELAY_PREFIX}${policyHash.slice(0, 8)}`;

const relayLabels = (hostPort: number, policyHash: string) => ({
  [MANAGED_LABEL]: "true",
  [RELAY_LABEL]: "true",
  [RELAY_PORT_LABEL]: String(hostPort),
  [POLICY_LABEL]: policyHash,
});

export const createRelayOperations = (client: EngineClient, hostAlias: string) => {
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

    if (network.Labels?.[MANAGED_LABEL] !== "true") {
      throw new LauncherError(`network ${name} exists but is not managed by pi-sandbox`, networkHint(name));
    }
  };

  const ensureNetwork = async (name: string, repoHash: string | undefined) => {
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
        Labels: { [MANAGED_LABEL]: "true", ...(repoHash === undefined ? {} : { [REPO_LABEL]: repoHash }) },
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
    const created = await client.json<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      query: { name: relayName(policyHash) },
      json: {
        Image: imageId,
        Entrypoint: ["socat"],
        Cmd: [`TCP-LISTEN:${RELAY_LISTEN_PORT},fork,reuseaddr`, `TCP:${hostAlias}:${hostPort}`],
        Labels: { ...relayLabels(hostPort, policyHash), [IMAGE_LABEL]: imageId },
        HostConfig: {
          NetworkMode: "bridge",
          ExtraHosts: [DOCKER_HOST_GATEWAY],
          Init: true,
          ReadonlyRootfs: true,
        },
      },
    });

    await startRelay(created.Id);

    return created.Id;
  };

  const ensureRelay = async (hostPort: number, policyHash: string, imageId: string) => {
    const relay = await inspectRelay(relayName(policyHash));

    if (relay !== undefined && matches(relay, relayLabels(hostPort, policyHash))) {
      if (relay.State?.Running !== true) {
        await startRelay(relay.Id);
      }

      return relay.Id;
    }

    if (relay !== undefined) {
      await client.call(
        { method: "DELETE", path: `/containers/${segment(relay.Id)}`, query: { force: true } },
        [404],
      );
    }

    return createRelay(hostPort, policyHash, imageId);
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

  const prepareProxyRoute = async (
    hostPort: number,
    policyHash: string,
    imageId: string,
    repoHash?: string,
  ): Promise<ProxyRoute> => {
    const network = repoNetworkName(repoHash);

    await ensureNetwork(network, repoHash);

    const relayId = await ensureRelay(hostPort, policyHash, imageId);

    return {
      network: { kind: "internal", name: network },
      address: `${await relayAddress(network, relayId)}:${RELAY_LISTEN_PORT}`,
    };
  };

  const removeNetwork = async (name: string) => {
    const network = await inspectNetwork(name);

    if (network === undefined || network.Labels?.[MANAGED_LABEL] !== "true") {
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

  const removeRepoNetwork = async (repoHash: string) => {
    await removeNetwork(repoNetworkName(repoHash));
  };

  const pruneNetworks = async (keepRepoHashes: string[]) => {
    const kept = new Set(keepRepoHashes.map((hash) => hash.slice(0, SHORT_REPO_HASH)));
    const listed = await client.json<NetworkSummary[]>({
      method: "GET",
      path: "/networks",
      query: { filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }) },
    });
    const candidates = listed
      .map((network) => network.Name ?? "")
      .filter((name) => {
        const match = PRUNABLE_NETWORK.exec(name);

        return match !== null && (match[1] === undefined || !kept.has(match[1]));
      });
    const removed = await Promise.all(candidates.map(removeNetwork));

    return candidates.filter((_name, index) => removed[index]);
  };

  return { prepareProxyRoute, removeRepoNetwork, pruneNetworks };
};
