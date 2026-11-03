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
  Containers?: Record<string, { IPv4Address?: string }> | null;
}

const RELAY_NETWORK = "pi-sandbox";

const RELAY_PREFIX = "pi-sandbox-relay-";

const MANAGED_LABEL = "pi-sandbox.managed";

const RELAY_LABEL = "pi-sandbox.relay";

const RELAY_PORT_LABEL = "pi-sandbox.relay-port";

const POLICY_LABEL = "pi-sandbox.proxy-policy-hash";

const IMAGE_LABEL = "pi-sandbox.relay-image";

const RELAY_LISTEN_PORT = 3128;

const DOCKER_HOST_GATEWAY = "host.docker.internal:host-gateway";

const NETWORK_HINT = "remove it (docker network rm pi-sandbox) so the launcher can create its own";

const relayName = (policyHash: string) => `${RELAY_PREFIX}${policyHash.slice(0, 8)}`;

const relayLabels = (hostPort: number, policyHash: string) => ({
  [MANAGED_LABEL]: "true",
  [RELAY_LABEL]: "true",
  [RELAY_PORT_LABEL]: String(hostPort),
  [POLICY_LABEL]: policyHash,
});

export const createRelayOperations = (client: EngineClient, hostAlias: string) => {
  const inspectNetwork = async () => {
    const response = await client.call({ method: "GET", path: `/networks/${segment(RELAY_NETWORK)}` }, [404]);

    return response.status === 404
      ? undefined
      : (JSON.parse(response.body.toString("utf8")) as NetworkInspect);
  };

  const assertManaged = (network: NetworkInspect) => {
    if (network.Internal !== true) {
      throw new LauncherError(`network ${RELAY_NETWORK} exists but is not internal`, NETWORK_HINT);
    }

    if (network.Labels?.[MANAGED_LABEL] !== "true") {
      throw new LauncherError(
        `network ${RELAY_NETWORK} exists but is not managed by pi-sandbox`,
        NETWORK_HINT,
      );
    }
  };

  const ensureNetwork = async () => {
    const existing = await inspectNetwork();

    if (existing !== undefined) {
      assertManaged(existing);

      return;
    }

    await client.call({
      method: "POST",
      path: "/networks/create",
      json: { Name: RELAY_NETWORK, Driver: "bridge", Internal: true, Labels: { [MANAGED_LABEL]: "true" } },
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

    await client.call({
      method: "POST",
      path: `/networks/${segment(RELAY_NETWORK)}/connect`,
      json: { Container: created.Id },
    });

    await startRelay(created.Id);

    return created.Id;
  };

  const ensureRelay = async (hostPort: number, policyHash: string, imageId: string) => {
    await ensureNetwork();

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

  const relayAddress = async (relayId: string) => {
    const network = await inspectNetwork();
    const address = network?.Containers?.[relayId]?.IPv4Address?.split("/")[0];

    if (address === undefined || address === "") {
      throw new LauncherError(`relay ${relayId.slice(0, 12)} has no address on network ${RELAY_NETWORK}`);
    }

    return address;
  };

  const prepareProxyRoute = async (
    hostPort: number,
    policyHash: string,
    imageId: string,
  ): Promise<ProxyRoute> => {
    const relayId = await ensureRelay(hostPort, policyHash, imageId);

    return {
      network: { kind: "internal", name: RELAY_NETWORK },
      address: `${await relayAddress(relayId)}:${RELAY_LISTEN_PORT}`,
    };
  };

  return { prepareProxyRoute };
};
