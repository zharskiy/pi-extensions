import { createHash } from "node:crypto";
import { LauncherError } from "../../shared/index.ts";
import { relayName } from "../install.ts";
import { LABELS } from "../labels.ts";
import type { RelayRequest } from "../types.ts";
import { confined } from "./container-body.ts";
import { type EngineClient, EngineTimeout, segment } from "./engine-client.ts";
import type { NetworkOperations } from "./networks.ts";
import { VM_HOST_ALIAS } from "./profile.ts";
import { RELAY_PREAMBLE_VARIABLE, RELAY_SCRIPT } from "./relay-script.ts";

interface RelayInspect {
  Id: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

export const PROXY_ALIAS = "pi-sandbox-proxy";

export const RELAY_LISTEN_PORT = 3128;

const RELAY_PIDS_LIMIT = 1024;

const relayInputsHash = (request: RelayRequest, subnet: string) =>
  createHash("sha256")
    .update(JSON.stringify([request.preamble, request.hostPort, subnet, RELAY_SCRIPT]))
    .digest("hex");

const relayLabels = (install: string, request: RelayRequest, subnet: string) => ({
  [LABELS.managed]: "true",
  [LABELS.install]: install,
  [LABELS.role]: "relay",
  [LABELS.relayInputs]: relayInputsHash(request, subnet),
});

const stillRemoving = (name: string) =>
  new LauncherError(
    `relay ${name} is still being removed by the engine, so its replacement cannot be created`,
    "run pi again in a minute",
  );

export const createRelayOperations = (
  client: EngineClient,
  install: string,
  networks: Pick<NetworkOperations, "name" | "subnet">,
  removeContainer: (id: string) => Promise<void>,
) => {
  const name = relayName(install);

  const attach = async (network: string, containerId: string) => {
    await client.call({
      method: "POST",
      path: `/networks/${segment(network)}/connect`,
      json: { Container: containerId, EndpointConfig: { Aliases: [PROXY_ALIAS] } },
    });
  };

  const inspectRelay = async () => {
    const response = await client.call({ method: "GET", path: `/containers/${segment(name)}/json` }, [404]);

    return response.status === 404 ? undefined : (JSON.parse(response.body.toString("utf8")) as RelayInspect);
  };

  const usable = (relay: RelayInspect | undefined, request: RelayRequest, subnet: string) =>
    relay !== undefined &&
    relay.State?.Running === true &&
    relay.Config?.Labels?.[LABELS.relayInputs] === relayInputsHash(request, subnet) &&
    relay.NetworkSettings?.Networks?.[networks.name] !== undefined;

  const createRelay = async (request: RelayRequest, subnet: string) => {
    const response = await client.call(
      {
        method: "POST",
        path: "/containers/create",
        query: { name },
        json: {
          Image: request.imageId,
          Entrypoint: ["node", "-e", RELAY_SCRIPT],
          Cmd: [String(RELAY_LISTEN_PORT), VM_HOST_ALIAS, String(request.hostPort), subnet],
          Env: [`${RELAY_PREAMBLE_VARIABLE}=${request.preamble}`],
          Labels: relayLabels(install, request, subnet),
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

    await attach(networks.name, created.Id);

    await client.call({ method: "POST", path: `/containers/${segment(created.Id)}/start` }, [304]);
  };

  const ensureRelay = async (request: RelayRequest, subnet: string) => {
    const relay = await inspectRelay();

    if (usable(relay, request, subnet)) {
      return;
    }

    if (relay !== undefined) {
      await removeContainer(relay.Id).catch((error: unknown) => {
        throw error instanceof EngineTimeout ? stillRemoving(name) : error;
      });
    }

    await createRelay(request, subnet);
  };

  const prepareRelay = async (request: RelayRequest) => {
    const subnet = await networks.subnet();

    await ensureRelay(request, subnet);

    return networks.name;
  };

  return { prepareRelay };
};
