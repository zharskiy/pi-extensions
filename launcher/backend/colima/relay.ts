import { LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import { RELAY_PREFIX, relayName, repoNetworkLabels, repoNetworkName } from "../managed-network.ts";
import type { NetworkSummary, ProxyRoute, ProxyRouteRequest } from "../types.ts";
import { type EngineContainer, labelFilters } from "./container-body.ts";
import { type EngineClient, segment } from "./engine-client.ts";
import { VM_HOST_ALIAS } from "./profile.ts";

interface RelayInspect {
  Id: string;
  State?: { Running?: boolean; Status?: string };
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

const REMOVAL_WAIT_MS = 10_000;

const RIVAL_POLL_MS = 100;

const RIVAL_POLL_ATTEMPTS = 150;

const FOREIGN_NETWORK_HINT = "remove that network from the sandbox VM so the launcher can create its own";

const relayLabels = (hostPort: number, repoHash: string) => ({
  [LABELS.managed]: "true",
  [LABELS.relay]: "true",
  [LABELS.repoHash]: repoHash,
  [LABELS.relayPort]: String(hostPort),
});

const realPause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export const createRelayOperations = (client: EngineClient, pause = realPause) => {
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

  const createNetwork = async (name: string, repoHash: string) => {
    const response = await client.call(
      {
        method: "POST",
        path: "/networks/create",
        json: {
          Name: name,
          Driver: "bridge",
          Internal: true,
          CheckDuplicate: true,
          Labels: repoNetworkLabels(repoHash),
        },
      },
      [409],
    );

    return response.status !== 409;
  };

  const ensureNetwork = async (name: string, repoHash: string) => {
    const existing = await inspectNetwork(name);

    if (existing === undefined && (await createNetwork(name, repoHash))) {
      return;
    }

    const network = existing ?? (await inspectNetwork(name));

    if (network === undefined) {
      throw new LauncherError(`network ${name} vanished while it was being created`, "run pi again");
    }

    assertManaged(name, network);
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

  const usable = (relay: RelayInspect | undefined, request: ProxyRouteRequest, network: string) =>
    relay !== undefined &&
    relay.State?.Running === true &&
    matches(relay, relayLabels(request.hostPort, request.repoHash)) &&
    relay.NetworkSettings?.Networks?.[network] !== undefined;

  const starting = (relay: RelayInspect | undefined, request: ProxyRouteRequest) =>
    relay !== undefined &&
    relay.State?.Status === "created" &&
    matches(relay, relayLabels(request.hostPort, request.repoHash));

  const createRelay = async (request: ProxyRouteRequest, network: string) => {
    const response = await client.call(
      {
        method: "POST",
        path: "/containers/create",
        query: { name: relayName(request.repoHash) },
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
          },
        },
      },
      [409],
    );

    if (response.status === 409) {
      return false;
    }

    const created = JSON.parse(response.body.toString("utf8")) as { Id: string };

    await attach(network, created.Id);

    await client.call({ method: "POST", path: `/containers/${segment(created.Id)}/start` }, [304]);

    return true;
  };

  const rivalReady = async (
    name: string,
    request: ProxyRouteRequest,
    network: string,
    attempts = RIVAL_POLL_ATTEMPTS,
  ): Promise<boolean> => {
    if (usable(await inspectRelay(name), request, network)) {
      return true;
    }

    if (attempts <= 1) {
      return false;
    }

    await pause(RIVAL_POLL_MS);

    return rivalReady(name, request, network, attempts - 1);
  };

  const removed = async (name: string, id: string, attempts = RIVAL_POLL_ATTEMPTS): Promise<boolean> => {
    if ((await inspectRelay(name))?.Id !== id) {
      return true;
    }

    if (attempts <= 1) {
      return false;
    }

    await pause(RIVAL_POLL_MS);

    return removed(name, id, attempts - 1);
  };

  const createAfterDrop = async (request: ProxyRouteRequest, network: string, dropped?: string) => {
    if (await createRelay(request, network)) {
      return "created";
    }

    const name = relayName(request.repoHash);

    if (dropped === undefined || (await inspectRelay(name))?.Id !== dropped) {
      return "rival";
    }

    if (!(await removed(name, dropped))) {
      return "stuck";
    }

    return (await createRelay(request, network)) ? "created" : "rival";
  };

  const ensureRelay = async (request: ProxyRouteRequest, network: string) => {
    const name = relayName(request.repoHash);
    const relay = await inspectRelay(name);

    if (usable(relay, request, network)) {
      return;
    }

    if (starting(relay, request) && (await rivalReady(name, request, network))) {
      return;
    }

    if (relay !== undefined) {
      await dropRelay(relay.Id);
    }

    const outcome = await createAfterDrop(request, network, relay?.Id);

    if (outcome === "stuck") {
      throw new LauncherError(
        `relay ${name} is still being removed by the engine, so its replacement cannot be created`,
        "run pi again in a minute",
      );
    }

    if (outcome === "rival" && !(await rivalReady(name, request, network))) {
      throw new LauncherError(
        `relay ${name} was created by another launch but did not start`,
        "run pi again",
      );
    }
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
