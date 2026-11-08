import { request } from "node:http";

const MANAGED_LABEL = "pi-sandbox.managed";

const RELAY_LABEL = "pi-sandbox.relay";

const PING_TIMEOUT_MS = 3000;

const [socketPath = "", ...flags] = process.argv.slice(2);

const dryRun = flags.includes("--dry-run");

const withVolumes = flags.includes("--volumes");

const call = (method, path, timeout = 0) =>
  new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path, timeout }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));

      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });

    outgoing.on("timeout", () => outgoing.destroy(new Error(`${method} ${path} timed out`)));

    outgoing.on("error", reject);

    outgoing.end();
  });

const listed = async (path) => {
  const response = await call("GET", path);

  if (response.status !== 200) {
    throw new Error(`GET ${path} answered ${response.status}: ${response.body.trim()}`);
  }

  return JSON.parse(response.body);
};

const remove = async (path) => {
  const response = await call("DELETE", path);

  if (response.status >= 300 && response.status !== 404) {
    throw new Error(`DELETE ${path} answered ${response.status}: ${response.body.trim()}`);
  }
};

const filtersQuery = (filters) => encodeURIComponent(JSON.stringify(filters));

const labelled = (label) => ({ label: [`${label}=true`] });

const isManaged = (labels) => labels?.[MANAGED_LABEL] === "true";

const reachable = async () => {
  try {
    return (await call("GET", "/_ping", PING_TIMEOUT_MS)).status === 200;
  } catch {
    return false;
  }
};

const containerIds = async (label) => {
  const containers = await listed(`/containers/json?all=1&filters=${filtersQuery(labelled(label))}`);

  return containers
    .filter((container) => container.Labels?.[label] === "true")
    .map((container) => container.Id);
};

const networkNames = async () => {
  const networks = await listed(
    `/networks?filters=${filtersQuery({ ...labelled(MANAGED_LABEL), name: ["pi-sandbox"] })}`,
  );

  return networks
    .filter((network) => network.Name.includes("pi-sandbox") && isManaged(network.Labels))
    .map((network) => network.Name);
};

const volumeNames = async () => {
  const listing = await listed(
    `/volumes?filters=${filtersQuery({ ...labelled(MANAGED_LABEL), name: ["pi-sandbox-"] })}`,
  );

  return (listing.Volumes ?? [])
    .filter((volume) => volume.Name.startsWith("pi-sandbox-") && isManaged(volume.Labels))
    .map((volume) => volume.Name);
};

const removeAll = async (paths) => {
  if (!dryRun) {
    await Promise.all(paths.map(remove));
  }
};

const verb = dryRun ? "would remove" : "removed";

const cleanContainers = async () => {
  const relays = await containerIds(RELAY_LABEL);
  const sandboxes = (await containerIds(MANAGED_LABEL)).filter((id) => !relays.includes(id));

  await removeAll([...sandboxes, ...relays].map((id) => `/containers/${encodeURIComponent(id)}?force=true`));

  const networks = await networkNames();

  await removeAll(networks.map((name) => `/networks/${encodeURIComponent(name)}`));

  console.log(
    `containers: ${verb} ${sandboxes.length} sandbox and ${relays.length} relay containers and ${networks.length} pi-sandbox networks`,
  );
};

const cleanVolumes = async () => {
  if (!withVolumes) {
    console.log("volumes: kept (pass --volumes to remove caches and older sandbox-only sessions)");

    return;
  }

  const volumes = await volumeNames();

  await removeAll(volumes.map((name) => `/volumes/${encodeURIComponent(name)}`));

  console.log(`volumes: ${verb} ${volumes.length} pi-sandbox volumes`);
};

const clean = async () => {
  if (!(await reachable())) {
    console.log("containers: no reachable docker engine, nothing removed");

    return;
  }

  await cleanContainers();

  await cleanVolumes();
};

try {
  await clean();
} catch (error) {
  console.error(`pi-sandbox uninstall: docker engine at ${socketPath}: ${error.message}`);

  process.exitCode = 1;
}
