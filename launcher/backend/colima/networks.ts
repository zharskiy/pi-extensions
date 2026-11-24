import { LauncherError } from "../../shared/index.ts";
import { networkName } from "../install.ts";
import { LABELS } from "../labels.ts";
import { labelFilters } from "./container-body.ts";
import { type EngineClient, segment } from "./engine-client.ts";

interface NetworkInspect {
  Labels?: Record<string, string> | null;
  IPAM?: { Config?: Array<{ Subnet?: string }> | null } | null;
}

const GATEWAY_MODE_OPTION = "com.docker.network.bridge.gateway_mode_ipv4";

const ISOLATED_GATEWAY_ENGINE = 28;

const IPV4_SUBNET = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

const engineMajor = (version: string | undefined) => Number((version ?? "").split(".")[0]);

const oldEngine = (version: string | undefined) =>
  new LauncherError(
    `the sandbox VM runs Docker Engine ${version ?? "of an unknown version"}, and the sandbox network needs 28.0 or later to keep the VM itself off it`,
    "update colima, then delete and recreate the sandbox VM so it gets a newer engine",
  );

const foreign = (name: string) =>
  new LauncherError(
    `network ${name} exists but is not managed by pinata`,
    "remove that network from the sandbox VM so pinata can create its own",
  );

const noSubnet = (name: string) =>
  new LauncherError(
    `network ${name} has no IPv4 subnet, so the relay cannot tell the sandbox containers from other clients`,
    "exit every pi session, remove that network from the sandbox VM and start pi again",
  );

const subnetOf = (name: string, network: NetworkInspect) => {
  const subnet = (network.IPAM?.Config ?? [])
    .map((entry) => entry.Subnet ?? "")
    .find((entry) => IPV4_SUBNET.test(entry));

  if (subnet === undefined) {
    throw noSubnet(name);
  }

  return subnet;
};

export const createNetworkOperations = (client: EngineClient, install: string) => {
  const name = networkName(install);
  const labels = { [LABELS.managed]: "true", [LABELS.install]: install };

  const inspectNetwork = async () => {
    const response = await client.call({ method: "GET", path: `/networks/${segment(name)}` }, [404]);

    return response.status === 404
      ? undefined
      : (JSON.parse(response.body.toString("utf8")) as NetworkInspect);
  };

  const create = async () => {
    const { Version } = await client.json<{ Version?: string }>({ method: "GET", path: "/version" });

    if (!(engineMajor(Version) >= ISOLATED_GATEWAY_ENGINE)) {
      throw oldEngine(Version);
    }

    await client.call({
      method: "POST",
      path: "/networks/create",
      json: {
        Name: name,
        Driver: "bridge",
        Internal: true,
        EnableIPv6: false,
        CheckDuplicate: true,
        Options: { [GATEWAY_MODE_OPTION]: "isolated" },
        Labels: labels,
      },
    });
  };

  const ensureNetwork = async () => {
    const existing = await inspectNetwork();

    if (existing === undefined) {
      await create();

      return inspectNetwork();
    }

    if (existing.Labels?.[LABELS.managed] !== "true") {
      throw foreign(name);
    }

    return existing;
  };

  const prepareNetwork = async () => {
    await ensureNetwork();

    return name;
  };

  const subnet = async () => {
    const network = await ensureNetwork();

    if (network === undefined) {
      throw noSubnet(name);
    }

    return subnetOf(name, network);
  };

  const deleteNetwork = (network: string) =>
    client.call({ method: "DELETE", path: `/networks/${segment(network)}` }, [403, 404, 409]);

  const removeNetwork = async () => {
    const listed = await client.json<Array<{ Name?: string }>>({
      method: "GET",
      path: "/networks",
      query: { filters: labelFilters(labels) },
    });

    const answers = await Promise.all(listed.map((network) => deleteNetwork(network.Name ?? "")));

    return answers.some((answer) => answer.status < 300);
  };

  return { name, prepareNetwork, subnet, removeNetwork };
};

export type NetworkOperations = ReturnType<typeof createNetworkOperations>;
