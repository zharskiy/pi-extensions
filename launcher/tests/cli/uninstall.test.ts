import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { bootTime, launcherRoot, processMark, processStart, stateLayout } from "../../shared/index.ts";
import { createFakeEngine, type FakeEngine } from "../support/fake-engine.ts";

const created: string[] = [];

const engines: FakeEngine[] = [];

const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));

  children.splice(0).forEach((child) => {
    child.kill("SIGKILL");
  });

  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const linkEngineSocket = async (root: string, socket: string) => {
  const link = join(root, "home", ".colima", "pi-sandbox", "docker.sock");

  await mkdir(dirname(link), { recursive: true });

  await symlink(socket, link);
};

const runUninstall = async (root: string, socket: string, flags: string[] = []) => {
  await linkEngineSocket(root, socket);

  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      "sh",
      [join(launcherRoot(), "uninstall.sh"), "--bin-dir", join(root, "local-bin"), ...flags],
      {
        env: {
          HOME: join(root, "home"),
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          PI_SANDBOX_STATE_DIR: join(root, "state"),
        },
      },
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

    child.on("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8"),
      }),
    );
  });
};

const managed = { [LABELS.managed]: "true" };

const seedEngine = (engine: FakeEngine) => {
  const container = (id: string, labels: Record<string, string>) => {
    engine.containers.set(id, {
      Id: id,
      Name: id,
      State: "running",
      body: { Image: "image", Labels: labels },
    });
  };

  const network = (name: string, labels: Record<string, string>) => {
    engine.networks.set(name, { body: { Name: name, Labels: labels }, connected: [] });
  };

  const volume = (name: string, labels: Record<string, string>) => {
    engine.volumes.set(name, Buffer.alloc(0));

    engine.volumeLabels.set(name, labels);
  };

  container("sandbox-1", managed);

  container("sandbox-2", { ...managed, [LABELS.repoHash]: "abc" });

  container("relay-1", { ...managed, [LABELS.relay]: "true" });

  container("foreign", { owner: "someone" });

  network("pi-sandbox", managed);

  network("pi-sandbox-0123456789ab", managed);

  network("pi-sandbox-other", {});

  network("elsewhere", managed);

  volume("pi-sandbox-cache", managed);

  volume("pi-sandbox-unlabelled", {});

  volume("other-data", managed);
};

const engineRoot = async () => {
  const root = await mkdtemp(join("/tmp", "psu-"));
  const engine = await createFakeEngine();

  created.push(root);

  engines.push(engine);

  seedEngine(engine);

  return { root, engine };
};

describe("uninstall.sh on the docker engine", () => {
  it("removes the labelled containers, counts relays once and removes the managed pi-sandbox networks", async () => {
    const { root, engine } = await engineRoot();
    const result = await runUninstall(root, engine.socketPath, ["--keep-vm"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "containers: removed 2 sandbox and 1 relay containers and 2 pi-sandbox networks",
    );
    expect(result.stdout).toContain("volumes: kept (pass --volumes");
    expect([...engine.containers.keys()]).toEqual(["foreign"]);
    expect([...engine.networks.keys()].sort()).toEqual(["elsewhere", "pi-sandbox-other"]);
    expect([...engine.volumes.keys()].sort()).toEqual([
      "other-data",
      "pi-sandbox-cache",
      "pi-sandbox-unlabelled",
    ]);
  });

  it("removes only the managed pi-sandbox volumes with --keep-vm --volumes, and with the VM by default", async () => {
    const { root, engine } = await engineRoot();
    const result = await runUninstall(root, engine.socketPath, ["--keep-vm", "--volumes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("volumes: removed 1 pi-sandbox volumes");
    expect(result.stdout).toContain("colima: profile pi-sandbox kept (--keep-vm)");
    expect([...engine.volumes.keys()].sort()).toEqual(["other-data", "pi-sandbox-unlabelled"]);

    const again = await engineRoot();
    const byDefault = await runUninstall(again.root, again.engine.socketPath);

    expect(byDefault.stdout).toContain("volumes: removed 1 pi-sandbox volumes");
    expect(byDefault.stdout).toContain("colima: no profile pi-sandbox");
  });

  it("lists what it would remove and removes nothing with --dry-run", async () => {
    const { root, engine } = await engineRoot();
    const result = await runUninstall(root, engine.socketPath, ["--dry-run", "--volumes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "containers: would remove 2 sandbox and 1 relay containers and 2 pi-sandbox networks",
    );
    expect(result.stdout).toContain("volumes: would remove 1 pi-sandbox volumes");
    expect(engine.containers.size).toBe(4);
    expect(engine.networks.size).toBe(4);
    expect(engine.volumes.size).toBe(3);
    expect(engine.requests.filter((request) => request.method === "DELETE")).toEqual([]);
  });

  it("removes nothing and says so when no engine answers on the socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-uninstall-"));

    created.push(root);

    const result = await runUninstall(root, join(root, "missing.sock"), ["--volumes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("containers: the sandbox VM engine is not running, nothing removed");
    expect(result.stdout).not.toContain("volumes:");
  });
});

const shimRoot = async (record?: { link: string; shim?: string }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-uninstall-")));
  const shim = join(root, "local-bin", "pi");

  created.push(root);

  await mkdir(join(root, "local-bin"), { recursive: true });

  await symlink("../lib/node_modules/pi-extensions-mz/launcher/bin/pi-sandbox", shim);

  if (record !== undefined) {
    await mkdir(join(root, "state"), { recursive: true });

    await writeFile(join(root, "state", "replaced-pi-link"), `${record.shim ?? shim}\n${record.link}\n`);
  }

  return { root, shim, record: join(root, "state", "replaced-pi-link") };
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("uninstall.sh and a replaced pi link", () => {
  it("puts back exactly the link install.sh replaced and forgets the record", async () => {
    const { root, shim, record } = await shimRoot({ link: "../../.pi/agent/bin/pi" });
    const result = await runUninstall(root, join(root, "missing.sock"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `launcher: removed ${shim}\nlauncher: restored ${shim} to ../../.pi/agent/bin/pi\n`,
    );
    expect(await readlink(shim)).toBe("../../.pi/agent/bin/pi");
    expect(await exists(record)).toBe(false);
  });

  it("leaves a record that names another shim alone", async () => {
    const { root, shim, record } = await shimRoot({
      link: "../../.pi/agent/bin/pi",
      shim: "/elsewhere/bin/pi",
    });
    const result = await runUninstall(root, join(root, "missing.sock"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `launcher: ${record} records the replaced pi link of /elsewhere/bin/pi, not ${shim}; left as it is\n`,
    );
    expect(await exists(shim)).toBe(false);
    expect(await exists(record)).toBe(true);
  });

  it("restores nothing when install.sh replaced no link", async () => {
    const { root, shim } = await shimRoot();
    const result = await runUninstall(root, join(root, "missing.sock"));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("restore");
    expect(await exists(shim)).toBe(false);
  });

  it("only says what it would restore with --dry-run", async () => {
    const { root, shim, record } = await shimRoot({ link: "../../.pi/agent/bin/pi" });
    const result = await runUninstall(root, join(root, "missing.sock"), ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`launcher: would restore ${shim} to ../../.pi/agent/bin/pi\n`);
    expect(await readlink(shim)).toBe("../lib/node_modules/pi-extensions-mz/launcher/bin/pi-sandbox");
    expect(await exists(record)).toBe(true);
  });
});

const idleProcess = async (detached = false) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached, stdio: "ignore" });

  children.push(child);

  await once(child, "spawn");

  return child;
};

const ended = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.signalCode)
    : once(child, "exit").then(([, signal]) => signal as NodeJS.Signals | null);

const sandboxState = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-uninstall-")));
  const stateDir = join(root, "state");
  const repoHash = "c".repeat(64);
  const files = stateLayout(stateDir).repo(repoHash);

  created.push(root);

  await mkdir(files.proxy.directory, { recursive: true });

  return { root, stateDir, files };
};

describe("uninstall.sh and the host side of the sandbox state", () => {
  it("removes a recorded pin and created dir, stops a live proxy and a sign-in, and removes the state dir", async () => {
    const { root, stateDir, files } = await sandboxState();
    const pin = join(root, "repo", ".git", "commondir");
    const createdDir = join(root, "repo", "node_modules");
    const foreignPin = join(root, "repo", ".git", "worktrees", "commondir");
    const proxy = await idleProcess();
    const login = await idleProcess(true);

    await mkdir(dirname(foreignPin), { recursive: true });

    await mkdir(createdDir, { recursive: true });

    await writeFile(pin, ".\n");

    await writeFile(foreignPin, "../..\n");

    await writeFile(
      files.pins,
      JSON.stringify([
        { path: pin, gitCommonDir: dirname(pin) },
        { path: foreignPin, gitCommonDir: dirname(foreignPin) },
      ]),
    );

    await writeFile(files.created, JSON.stringify([createdDir]));

    await writeFile(
      files.proxy.record,
      JSON.stringify({
        pid: proxy.pid,
        boot: bootTime(),
        start: await processStart(proxy.pid ?? 0),
        port: 1,
        inputHash: "x",
      }),
    );

    await writeFile(
      stateLayout(stateDir).mcpLogin,
      JSON.stringify({
        "mcp__docs|https://docs.example.com/": { running: { pgid: login.pid, boot: bootTime() } },
      }),
    );

    const result = await runUninstall(root, join(root, "missing.sock"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("git: removed 1 git pins\n");
    expect(result.stdout).toContain("mount points: removed 1 created directories\n");
    expect(result.stdout).toContain("proxy: stopped 1 proxies\n");
    expect(result.stdout).toContain("mcp: stopped 1 sign-ins\n");
    expect(await ended(proxy)).toBe("SIGTERM");
    expect(await ended(login)).toBe("SIGTERM");
    expect(await exists(pin)).toBe(false);
    expect(await exists(foreignPin)).toBe(true);
    expect(await exists(createdDir)).toBe(false);
    expect(await exists(stateDir)).toBe(false);
  });

  it("leaves a proxy record whose pid now runs another process and a created dir that is no longer empty", async () => {
    const { root, files } = await sandboxState();
    const createdDir = join(root, "repo", "node_modules");
    const proxy = await idleProcess();

    await mkdir(join(createdDir, "kept"), { recursive: true });

    await writeFile(files.created, JSON.stringify([createdDir]));

    await writeFile(
      files.proxy.record,
      JSON.stringify({ pid: proxy.pid, boot: bootTime(), start: "Thu-Jan-1-00:00:00-1970" }),
    );

    const result = await runUninstall(root, join(root, "missing.sock"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("proxy: stopped 0 proxies\n");
    expect(proxy.exitCode).toBeNull();
    expect(await exists(join(createdDir, "kept"))).toBe(true);
  });

  it("refuses and removes nothing while a launch is live", async () => {
    const { root, stateDir, files } = await sandboxState();
    const pin = join(root, "pin");

    await writeFile(pin, ".\n");

    await writeFile(files.pins, JSON.stringify([{ path: pin, gitCommonDir: root }]));

    await mkdir(files.launches, { recursive: true });

    await writeFile(
      join(files.launches, "00000000000000aa.json"),
      JSON.stringify({ ...(await processMark()), launchId: "00000000000000aa" }),
    );

    const result = await runUninstall(root, join(root, "missing.sock"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exit the pi sessions first");
    expect(result.stdout).not.toContain("launcher:");
    expect(await exists(pin)).toBe(true);
    expect(await exists(stateDir)).toBe(true);
  });
});
