import { execFile } from "node:child_process";
import { lstat, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { request } from "node:http";
import { uptime } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MANAGED_LABEL = "pi-sandbox.managed";

const RELAY_LABEL = "pi-sandbox.relay";

const PING_TIMEOUT_MS = 3000;

const HOST_SIDE = "--host-side";

const BOOT_SKEW_SECONDS = 30;

const STOP_GRACE_MS = 2000;

const EXIT_POLL_MS = 50;

const REPO_HASH = /^[0-9a-f]{64}$/;

const PIN = /^\.\n?$/;

const START_FIELD = 19;

const args = process.argv.slice(2);

const hostSide = args[0] === HOST_SIDE;

const [target = "", ...flags] = hostSide ? args.slice(1) : args;

const dryRun = flags.includes("--dry-run");

const withVolumes = flags.includes("--volumes");

const call = (method, path, timeout = 0) =>
  new Promise((resolve, reject) => {
    const outgoing = request({ socketPath: target, method, path, timeout }, (response) => {
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
    console.log("volumes: kept (pass --volumes to remove them)");

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

const bootTime = () => Math.round(Date.now() / 1000 - uptime());

const alive = (pid) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const isMark = (mark) =>
  Number.isInteger(mark?.pid) &&
  mark.pid > 0 &&
  Number.isFinite(mark.boot) &&
  typeof mark.start === "string" &&
  mark.start !== "";

const psStart = (pid) =>
  new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C" } }, (error, stdout) => {
      const text = stdout.trim().split(/\s+/).join("-");

      resolve(error === null && text !== "" ? text : undefined);
    });
  });

const procStart = async (pid) => {
  const text = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  const fields = text
    ?.slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ");

  return fields?.[START_FIELD];
};

const processStart = (pid) => (process.platform === "linux" ? procStart(pid) : psStart(pid));

const sameBoot = (boot) => Math.abs(boot - bootTime()) <= BOOT_SKEW_SECONDS;

const readJson = (path) =>
  readFile(path, "utf8").then(
    (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    },
    () => undefined,
  );

const liveMark = async (path) => {
  const mark = await readJson(path);
  const live =
    isMark(mark) && sameBoot(mark.boot) && alive(mark.pid) && (await processStart(mark.pid)) === mark.start;

  return live ? mark : undefined;
};

const entriesOf = (path) => readdir(path).catch(() => []);

const repoDirs = async (stateDir) => {
  const names = await entriesOf(join(stateDir, "repos"));

  return names.filter((name) => REPO_HASH.test(name)).map((name) => join(stateDir, "repos", name));
};

const liveLaunches = async (repo) => {
  const launches = join(repo, "launches");
  const names = (await entriesOf(launches)).filter((name) => name.endsWith(".json"));
  const marks = await Promise.all(names.map((name) => liveMark(join(launches, name))));

  return marks.filter((mark) => mark !== undefined).length;
};

const readList = async (path) => {
  const value = await readJson(path);

  return Array.isArray(value) ? value : [];
};

const removePin = async (pin) => {
  const info = typeof pin?.path === "string" ? await lstat(pin.path).catch(() => undefined) : undefined;
  const text = info?.isFile() ? await readFile(pin.path, "utf8").catch(() => undefined) : undefined;

  if (text === undefined || !PIN.test(text)) {
    return [];
  }

  if (!dryRun) {
    await unlink(pin.path).catch(() => undefined);
  }

  return [pin.path];
};

const depthOf = (path) => path.split(sep).length;

const removeCreatedDir = async (removed, path) => {
  const done = await removed;
  const info = await lstat(path).catch(() => undefined);

  if (info === undefined || !info.isDirectory()) {
    return done;
  }

  if (dryRun) {
    return [...done, path];
  }

  return rmdir(path).then(
    () => [...done, path],
    () => done,
  );
};

const removeCreatedDirs = async (repo) => {
  const dirs = (await readList(join(repo, "created.json"))).filter((dir) => typeof dir === "string");

  return [...new Set(dirs)]
    .sort((first, second) => depthOf(second) - depthOf(first) || second.localeCompare(first))
    .reduce(removeCreatedDir, Promise.resolve([]));
};

const exited = async (pid, deadline) => {
  if (!alive(pid)) {
    return true;
  }

  if (Date.now() >= deadline) {
    return false;
  }

  await sleep(EXIT_POLL_MS);

  return exited(pid, deadline);
};

const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch {
    return;
  }
};

const stopProxy = async (repo) => {
  const proxy = await liveMark(join(repo, "proxy", "proxy.json"));

  if (proxy === undefined) {
    return [];
  }

  if (!dryRun) {
    signal(proxy.pid, "SIGTERM");

    if (!(await exited(proxy.pid, Date.now() + STOP_GRACE_MS))) {
      signal(proxy.pid, "SIGKILL");
    }
  }

  return [proxy.pid];
};

const stopLogins = async (stateDir) => {
  const logins = Object.values((await readJson(join(stateDir, "mcp-login.json"))) ?? {});
  const recorded = logins
    .map((login) => login?.running)
    .filter(
      (running) =>
        Number.isInteger(running?.pgid) &&
        running.pgid > 0 &&
        Number.isFinite(running.boot) &&
        typeof running.start === "string" &&
        running.start !== "",
    )
    .filter((running) => sameBoot(running.boot) && alive(-running.pgid));
  const starts = await Promise.all(recorded.map((running) => processStart(running.pgid)));
  const groups = recorded.filter((running, index) => starts[index] === running.start);

  if (!dryRun) {
    groups.forEach((running) => {
      signal(-running.pgid, "SIGTERM");
    });
  }

  return groups.length;
};

const cleanRepo = async (repo) => {
  const pins = await Promise.all((await readList(join(repo, "pins.json"))).map(removePin));
  const dirs = await removeCreatedDirs(repo);
  const proxies = await stopProxy(repo);

  return { pins: pins.flat().length, dirs: dirs.length, proxies: proxies.length };
};

const sum = (totals, counts) => ({
  pins: totals.pins + counts.pins,
  dirs: totals.dirs + counts.dirs,
  proxies: totals.proxies + counts.proxies,
});

const cleanHostSide = async (stateDir) => {
  const repos = await repoDirs(stateDir);
  const live = (await Promise.all(repos.map(liveLaunches))).reduce((total, count) => total + count, 0);

  if (live > 0) {
    console.error(
      `pi-sandbox uninstall: ${live} pi sessions still run in the sandbox; exit the pi sessions first`,
    );

    process.exitCode = 1;

    return;
  }

  const counts = (await Promise.all(repos.map(cleanRepo))).reduce(sum, { pins: 0, dirs: 0, proxies: 0 });
  const logins = await stopLogins(stateDir);

  console.log(`git: ${verb} ${counts.pins} git pins`);

  console.log(`mount points: ${verb} ${counts.dirs} created directories`);

  console.log(`proxy: ${dryRun ? "would stop" : "stopped"} ${counts.proxies} proxies`);

  console.log(`mcp: ${dryRun ? "would stop" : "stopped"} ${logins} sign-ins`);
};

const runHostSide = async () => {
  try {
    await cleanHostSide(target);
  } catch (error) {
    console.error(`pi-sandbox uninstall: state at ${target}: ${error.message}`);

    process.exitCode = 1;
  }
};

const runEngine = async () => {
  try {
    await clean();
  } catch (error) {
    console.error(`pi-sandbox uninstall: docker engine at ${target}: ${error.message}`);

    process.exitCode = 1;
  }
};

await (hostSide ? runHostSide() : runEngine());
