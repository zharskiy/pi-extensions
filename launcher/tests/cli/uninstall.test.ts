import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LABELS, networkName } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import {
  bootTime,
  launcherRoot,
  processMark,
  processStart,
  sha256Hex,
  stateLayout,
} from "../../shared/index.ts";
import { FAKE_NETWORK, FAKE_RELAY } from "../support/fake-backend.ts";
import { exists, tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, holdLaunch, unreachable } from "./harness.ts";

const created: string[] = [];

const children: ChildProcess[] = [];

afterEach(async () => {
  children.splice(0).forEach((child) => {
    child.kill("SIGKILL");
  });

  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const UNINSTALL_TIMEOUT_MS = 30_000;

const FAKE_COLIMA = [
  'echo "$COLIMA_HOME $*" >> "$HOME/colima.log"',
  'case "$1" in list) [ -f "$HOME/no-profile" ] || echo "pi-sandbox  Running" ;; delete) exit "$DELETE_EXIT" ;; esac',
].join("\n");

interface Root {
  root: string;
  home: string;
  stateDir: string;
  tools: string;
}

const uninstallRoot = async (): Promise<Root> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-uninstall-")));
  const home = join(root, "home");
  const tools = join(root, "tools");

  created.push(root);

  await mkdir(join(home, ".local", "bin"), { recursive: true });

  await mkdir(tools, { recursive: true });

  await writeFile(join(tools, "colima"), `#!/bin/sh\n${FAKE_COLIMA}\n`);

  await writeFile(join(tools, "npm"), "#!/bin/sh\nexit 1\n");

  await Promise.all(["colima", "npm"].map((name) => chmod(join(tools, name), 0o755)));

  return { root, home, stateDir: join(root, "state"), tools };
};

const runUninstall = async (paths: Root, env: Record<string, string> = {}, script = launcherRoot()) => {
  const child = spawn("sh", [join(script, "uninstall.sh")], {
    env: {
      HOME: paths.home,
      PATH: `${paths.tools}:${dirname(process.execPath)}:/usr/bin:/bin`,
      PI_SANDBOX_STATE_DIR: paths.stateDir,
      DELETE_EXIT: "0",
      ...env,
    },
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

  const [status] = (await once(child, "close")) as [number | null];

  return {
    status,
    stdout: Buffer.concat(chunks).toString("utf8"),
    stderr: Buffer.concat(errors).toString("utf8"),
  };
};

const colimaLog = (paths: Root) => readFile(join(paths.home, "colima.log"), "utf8").catch(() => "");

const idleProcess = async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

  children.push(child);

  await once(child, "spawn");

  return child;
};

const ended = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.signalCode)
    : once(child, "exit").then(([, signal]) => signal as NodeJS.Signals | null);

describe("the hidden uninstall command", () => {
  it("refuses while a launch is live and removes nothing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const id = fake.addContainer({
      name: "live",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent" },
      state: "running",
      image: "x",
    });

    await holdLaunch(harness);

    expect(await run(["__uninstall"], harness.deps)).toBe(75);
    expect(harness.stderr()).toContain(
      "pi-sandbox: 1 pi session is running in the sandbox VM; exit them first",
    );
    expect(fake.containers.has(id)).toBe(true);
  });

  it("removes the managed containers, networks, volumes and images by label, leaves another install's, and releases every folder", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);
    const context = await tempDir("uninstall-images");

    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PI-SANDBOX test" });

    const managed = fake.addContainer({
      name: "pi-sandbox-a",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: repo },
      state: "running",
      image: "x",
    });
    const foreign = fake.addContainer({ name: "foreign", labels: {}, state: "running", image: "x" });
    const other = fake.backendFor("otherinstall");
    const othersContainer = fake.addContainer({
      name: "pi-sandbox-other",
      labels: { [LABELS.managed]: "true", [LABELS.install]: "otherinstall", [LABELS.role]: "agent" },
      state: "stopped",
      image: "x",
    });

    await other.prepareNetwork();

    await other.ensureVolume("pi-sandbox-agent-other");

    await fake.backend.ensureVolume("pi-sandbox-agent-a", { [LABELS.repoHash]: repo });

    const built = await fake.backend.buildImage(context, "pi-sandbox-layer:a");

    await harness.writeJson(stateLayout(harness.stateDir).repo(repo).record, { root: harness.repoRoot });

    expect(await run(["__uninstall"], harness.deps)).toBe(0);
    expect(fake.containers.has(managed)).toBe(false);
    expect(fake.containers.has(foreign)).toBe(true);
    expect(fake.containers.has(othersContainer)).toBe(true);
    expect(fake.relays.size).toBe(0);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
    expect(fake.networks.has(networkName("otherinstall"))).toBe(true);
    expect(fake.volumes.has("pi-sandbox-agent-a")).toBe(false);
    expect(fake.volumes.has("pi-sandbox-agent-other")).toBe(true);
    expect(fake.imageRemovals).toContain(built.id);
    expect(harness.proxyStops()).toBe(1);
    expect(harness.stdout()).toContain(`install: removed relay ${FAKE_RELAY}\n`);
    expect(harness.stdout()).toContain("host: released the created folders of 1 folders\n");
  });

  it("keeps the sandbox, the ground and the stored objects when a pi session starts while the uninstall runs", async () => {
    const fake = createFakeBackend();
    const detections = { count: 0 };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        detect: async () => {
          detections.count += 1;

          if (detections.count === 2) {
            await holdLaunch(harness);
          }

          return { available: true };
        },
      }),
    });
    const repo = sha256Hex(harness.repoRoot);

    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PI-SANDBOX test" });

    const starting = fake.addContainer({
      name: "pi-sandbox-starting",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent", [LABELS.repoHash]: repo },
      state: "running",
      image: "x",
    });

    await fake.backend.ensureVolume("pi-sandbox-agent-a", { [LABELS.repoHash]: repo });

    expect(await run(["__uninstall"], harness.deps)).toBe(75);
    expect(fake.containers.has(starting)).toBe(true);
    expect(fake.relays.size).toBe(1);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(true);
    expect(fake.volumes.has("pi-sandbox-agent-a")).toBe(true);
    expect(harness.proxyStops()).toBe(0);
    expect(harness.stdout()).toContain(
      `host: a pi session of ${repo.slice(0, 12)} started meanwhile; its sandbox stays\n`,
    );
    expect(harness.stderr()).toContain("the sandbox network, proxy, services, volumes and images were kept");
  });

  it("holds a pi session that registers during the removal of the install objects until the removal ends", async () => {
    const fake = createFakeBackend();
    const order: string[] = [];
    const registering = { done: Promise.resolve() };
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        removeVolume: async (name) => {
          registering.done = holdLaunch(harness).then(() => {
            order.push("registered");
          });

          await new Promise((resolve) => setTimeout(resolve, 100));

          order.push("removed");

          return fake.backend.removeVolume(name);
        },
      }),
    });

    await fake.backend.ensureVolume("pi-sandbox-cache-a");

    expect(await run(["__uninstall"], harness.deps)).toBe(0);

    await registering.done;

    expect(order).toEqual(["removed", "registered"]);
    expect(fake.volumes.has("pi-sandbox-cache-a")).toBe(false);
  });

  it("releases the host side and leaves the engine objects to the profile when the VM is stopped", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const repo = "c".repeat(64);
    const mountPoint = join(harness.root, "elsewhere", "node_modules");

    await mkdir(mountPoint, { recursive: true });

    await harness.writeJson(stateLayout(harness.stateDir).repo(repo).created, [mountPoint]);

    expect(await run(["__uninstall"], harness.deps)).toBe(0);
    expect(await exists(mountPoint)).toBe(false);
    expect(harness.proxyStops()).toBe(1);
    expect(harness.stdout()).toContain(
      "engine: the sandbox VM is not running, its objects go with the colima profile\n",
    );
  });

  it("stops the proxy when listing the engine's containers fails", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        findContainers: () => Promise.reject(new Error("engine broke")),
      }),
    });

    expect(await run(["__uninstall"], harness.deps)).toBe(0);
    expect(harness.proxyStops()).toBe(1);
    expect(harness.stdout()).toContain(
      "install: the sandbox network, proxy and services were not all released: engine broke\n",
    );
  });
});

describe("uninstall.sh", { timeout: UNINSTALL_TIMEOUT_MS }, () => {
  it("removes the created dirs, stops a live proxy, deletes the profile and removes the state dir", async () => {
    const paths = await uninstallRoot();
    const layout = stateLayout(paths.stateDir);
    const files = layout.repo("c".repeat(64));
    const createdDir = join(paths.root, "repo", "node_modules");
    const proxy = await idleProcess();

    await mkdir(layout.proxy.directory, { recursive: true });

    await mkdir(files.directory, { recursive: true });

    await mkdir(createdDir, { recursive: true });

    await writeFile(files.created, JSON.stringify([createdDir]));

    await writeFile(
      layout.proxy.record,
      JSON.stringify({
        pid: proxy.pid,
        boot: bootTime(),
        start: await processStart(proxy.pid ?? 0),
        port: 1,
        inputHash: "x",
      }),
    );

    const result = await runUninstall(paths, { COLIMA_HOME: "/elsewhere" });

    expect(result.status).toBe(0);
    expect(await exists(createdDir)).toBe(false);
    expect(await ended(proxy)).toBe("SIGTERM");
    expect(await exists(paths.stateDir)).toBe(false);
    expect(result.stdout).toContain(
      "colima: deleted profile pi-sandbox with its containers, volumes and images\n",
    );
    expect((await colimaLog(paths)).split("\n")).toContain(
      `${join(paths.home, ".colima")} delete --profile pi-sandbox --force`,
    );
  });

  it("refuses and removes nothing while a launch is live", async () => {
    const paths = await uninstallRoot();
    const layout = stateLayout(paths.stateDir);
    const files = layout.repo("c".repeat(64));
    const createdDir = join(paths.root, "repo", "node_modules");

    await mkdir(layout.launches, { recursive: true });

    await mkdir(files.directory, { recursive: true });

    await mkdir(createdDir, { recursive: true });

    await writeFile(files.created, JSON.stringify([createdDir]));

    await writeFile(
      join(layout.launches, "00000000000000aa.json"),
      JSON.stringify({ ...(await processMark()), launchId: "00000000000000aa", repoHash: "c".repeat(64) }),
    );

    const result = await runUninstall(paths);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "pi sessions still run in the sandbox VM, so the VM and the host files stay",
    );
    expect(await exists(createdDir)).toBe(true);
    expect(await exists(paths.stateDir)).toBe(true);
    expect(await colimaLog(paths)).not.toContain("delete");
  });

  it("still deletes the profile and the host files when the launcher is missing", async () => {
    const paths = await uninstallRoot();
    const copy = join(paths.root, "copy", "launcher");
    const shim = join(paths.home, ".local", "bin", "pi");

    await mkdir(join(copy, "bin"), { recursive: true });

    await writeFile(join(copy, "uninstall.sh"), await readFile(join(launcherRoot(), "uninstall.sh"), "utf8"));

    await Promise.all(
      ["path-block.sh", "paths.sh", "shim.sh"].map(async (name) =>
        writeFile(join(copy, "bin", name), await readFile(join(launcherRoot(), "bin", name), "utf8")),
      ),
    );

    await mkdir(paths.stateDir, { recursive: true });

    await symlink("../lib/node_modules/pi-extensions-mz/launcher/bin/pi-sandbox", shim);

    const result = await runUninstall(paths, {}, copy);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("launcher: not found");
    expect(await colimaLog(paths)).toContain("delete --profile pi-sandbox --force");
    expect(await exists(shim)).toBe(false);
    expect(await exists(paths.stateDir)).toBe(false);
  });

  it("removes the state under pi's agent dir and keeps the user config", async () => {
    const paths = await uninstallRoot();
    const folder = join(paths.home, ".pi", "agent", "pi-sandbox");

    await mkdir(join(folder, "state", "ca"), { recursive: true });

    await writeFile(join(folder, "config.json"), "{}");

    const result = await runUninstall(paths, { PI_SANDBOX_STATE_DIR: "" });

    expect(result.status).toBe(0);
    expect(await exists(join(folder, "state"))).toBe(false);
    expect(await readFile(join(folder, "config.json"), "utf8")).toBe("{}");
    expect(result.stdout).toContain(`state: removed ${join(folder, "state")}\n`);
    expect(result.stdout).toContain(
      `kept: your repositories, ~/.pi and your launcher config ${join(folder, "config.json")}\n`,
    );
  });

  it("expands ~ in PI_CODING_AGENT_DIR as pi does", async () => {
    const paths = await uninstallRoot();
    const folder = join(paths.home, "work", "agent", "pi-sandbox");

    await mkdir(join(folder, "state"), { recursive: true });

    const result = await runUninstall(paths, {
      PI_SANDBOX_STATE_DIR: "",
      PI_CODING_AGENT_DIR: "~/work/agent",
    });

    expect(result.status).toBe(0);
    expect(await exists(folder)).toBe(false);
    expect(result.stdout).toContain(`state: removed ${join(folder, "state")}\n`);
    expect(result.stdout).toContain(
      `kept: your pi sessions stay in ${join(paths.home, "work", "agent", "sessions")}\n`,
    );
  });

  it("removes the launcher folder under pi's agent dir when nothing is left in it", async () => {
    const paths = await uninstallRoot();
    const folder = join(paths.home, ".pi", "agent", "pi-sandbox");

    await mkdir(join(folder, "state"), { recursive: true });

    expect((await runUninstall(paths, { PI_SANDBOX_STATE_DIR: "" })).status).toBe(0);
    expect(await exists(folder)).toBe(false);
    expect(await exists(join(paths.home, ".pi", "agent"))).toBe(true);
  });

  it("fails naming the command when colima cannot delete the profile", async () => {
    const paths = await uninstallRoot();
    const result = await runUninstall(paths, { DELETE_EXIT: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "the colima profile pi-sandbox could not be deleted; run colima delete --profile pi-sandbox --force",
    );
  });

  it("puts back exactly the link install.sh replaced, and names it when the path is taken", async () => {
    const paths = await uninstallRoot();
    const shim = join(paths.home, ".local", "bin", "pi");
    const record = join(paths.stateDir, "replaced-pi-link");

    await mkdir(paths.stateDir, { recursive: true });

    await writeFile(record, "../../.pi/agent/bin/pi\n");

    await symlink("../lib/node_modules/pi-extensions-mz/launcher/bin/pi-sandbox", shim);

    const restored = await runUninstall(paths);

    expect(restored.status).toBe(0);
    expect(await readlink(shim)).toBe("../../.pi/agent/bin/pi");
    expect(await exists(record)).toBe(false);

    await rm(shim);

    await writeFile(shim, "#!/bin/sh\necho mine\n");

    await mkdir(paths.stateDir, { recursive: true });

    await writeFile(record, "../../.pi/agent/bin/pi\n");

    const taken = await runUninstall(paths);

    expect(taken.status).toBe(0);
    expect(taken.stdout).toContain(`launcher: ${shim} is not the pi-sandbox launcher, left as it is\n`);
    expect(taken.stdout).toContain(`pi's managed link was ${shim} -> ../../.pi/agent/bin/pi`);
    expect(await readFile(shim, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("removes its PATH blocks and the fish file, and leaves an rc file whose markers do not pair up", async () => {
    const paths = await uninstallRoot();
    const fish = join(paths.home, ".config", "fish", "conf.d", "pi-sandbox.fish");
    const zshrc = join(paths.home, ".zshrc");
    const bashrc = join(paths.home, ".bashrc");
    const broken = "alias a=1\n# pi-sandbox begin\nexport KEEP=me\n";

    await mkdir(dirname(fish), { recursive: true });

    await writeFile(fish, "\n# pi-sandbox begin\nset -gx PATH '/opt/bin' $PATH\n# pi-sandbox end\n");

    await writeFile(
      zshrc,
      "alias ll=ls\n\n# pi-sandbox begin\nexport PATH='/opt/bin':\"$PATH\"\n# pi-sandbox end\n",
    );

    await writeFile(bashrc, broken);

    await writeFile(join(paths.home, "no-profile"), "");

    const result = await runUninstall(paths);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("colima: no profile pi-sandbox\n");
    expect(await exists(fish)).toBe(false);
    expect(await readFile(zshrc, "utf8")).toBe("alias ll=ls\n\n");
    expect(await readFile(bashrc, "utf8")).toBe(broken);
    expect(result.stdout).toContain("left as it is");
  });

  it("takes no options", async () => {
    const paths = await uninstallRoot();
    const result = await runUninstall(paths, {}, launcherRoot());
    const keepVm = await new Promise<number | null>((resolve) => {
      const child = spawn("sh", [join(launcherRoot(), "uninstall.sh"), "--keep-vm"], {
        env: { HOME: paths.home, PATH: `${paths.tools}:/usr/bin:/bin`, PI_SANDBOX_STATE_DIR: paths.stateDir },
      });

      child.on("close", resolve);
    });

    expect(result.status).toBe(0);
    expect(keepVm).toBe(1);
  });
});
