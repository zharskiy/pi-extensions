import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { launcherRoot } from "../../shared/index.ts";
import { createFakeEngine, type FakeEngine } from "../support/fake-engine.ts";

const created: string[] = [];

const engines: FakeEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));

  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const linkEngineSocket = async (root: string, socket: string) => {
  const link = join(root, "home", ".colima", "pi-sandbox", "docker.sock");

  await mkdir(dirname(link), { recursive: true });

  await symlink(socket, link);
};

const runUninstall = async (root: string, socket: string, flags: string[] = []) => {
  await linkEngineSocket(root, socket);

  return new Promise<{ status: number | null; stdout: string }>((resolve) => {
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

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("close", (status) => resolve({ status, stdout: Buffer.concat(chunks).toString("utf8") }));
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
    const result = await runUninstall(root, engine.socketPath);

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

  it("removes only the managed pi-sandbox volumes with --volumes", async () => {
    const { root, engine } = await engineRoot();
    const result = await runUninstall(root, engine.socketPath, ["--volumes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("volumes: removed 1 pi-sandbox volumes");
    expect([...engine.volumes.keys()].sort()).toEqual(["other-data", "pi-sandbox-unlabelled"]);
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
