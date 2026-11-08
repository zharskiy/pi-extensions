import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecSpec } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { registerSession } from "../../grants/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { hostSessionsDir } from "../../workspace/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness, isPiSession } from "./harness.ts";

const CUSTOM_NOTICE =
  "pi-sandbox: sessions: host pi uses a custom session dir, so sandbox sessions stay in the sandbox volume\n";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const isProbe = (spec: ExecSpec) => spec.command.join(" ").includes("PI_CODING_AGENT_SESSION_DIR");

const header = (cwd: string) => `${JSON.stringify({ type: "session", id: "abc", cwd })}\n`;

const sandboxWith = async (onPi: (dir: string) => Promise<void> = async () => undefined, probeExit = 0) => {
  const box = { dir: "" };
  const fake = createFakeBackend({
    exec: async (spec) => {
      if (isProbe(spec)) {
        return probeExit;
      }

      if (isPiSession(spec)) {
        await onPi(box.dir);
      }

      return 0;
    },
  });
  const harness = await createHarness({ backend: () => fake.backend });

  box.dir = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);

  return { fake, harness, dir: box.dir };
};

const containerSpec = (fake: ReturnType<typeof createFakeBackend>) => [...fake.containers.values()][0]?.spec;

describe("pi launch with host sessions", () => {
  it("binds the repository's host session dir at its own path, creates it 0700 and points pi at it", async () => {
    const { fake, harness, dir } = await sandboxWith();

    expect(await run([], harness.deps)).toBe(0);

    const spec = containerSpec(fake);

    expect(dir).toBe(
      join(harness.hostAgentDir, "sessions", `--${harness.repoRoot.slice(1).replaceAll("/", "-")}--`),
    );
    expect(spec?.mounts).toContainEqual({ source: dir, target: dir, readOnly: false, kind: "bind" });
    expect(spec?.env.PI_CODING_AGENT_SESSION_DIR).toBe(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(harness.hostAgentDir, "sessions"))).mode & 0o777).toBe(0o700);
    expect(fake.execs.some((exec) => isProbe(exec.spec))).toBe(true);
  });

  it("keeps sessions in the volume, quietly, when the user config turns sessions.host off", async () => {
    const { fake, harness, dir } = await sandboxWith();

    await harness.writeJson(harness.userConfigFile, { sessions: { host: false } });

    expect(await run([], harness.deps)).toBe(0);
    expect(containerSpec(fake)?.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(containerSpec(fake)?.mounts.some((mount) => mount.target === dir)).toBe(false);
    expect(await exists(join(harness.hostAgentDir, "sessions"))).toBe(false);
    expect(harness.stderr()).not.toContain("sessions:");
  });

  it("keeps sessions in the volume with a notice when host pi uses a custom session dir", async () => {
    const byEnv = await sandboxWith();
    const bySettings = await sandboxWith();

    byEnv.harness.deps.env.PI_CODING_AGENT_SESSION_DIR = "/shared/sessions";

    await bySettings.harness.writeJson(join(bySettings.harness.hostAgentDir, "settings.json"), {
      sessionDir: "~/all-sessions",
    });

    expect(await run([], byEnv.harness.deps)).toBe(0);
    expect(await run([], bySettings.harness.deps)).toBe(0);

    [byEnv, bySettings].forEach(({ fake, harness, dir }) => {
      expect(containerSpec(fake)?.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
      expect(containerSpec(fake)?.mounts.some((mount) => mount.target === dir)).toBe(false);
      expect(harness.stderr()).toContain(CUSTOM_NOTICE);
    });
  });

  it("stops with a hint and removes the new container when the sandbox cannot write the directory", async () => {
    const { fake, harness, dir } = await sandboxWith(async () => undefined, 1);

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pi-sandbox: sessions: ${dir} is not writable from the sandbox; set sessions.host: false or share it with the VM\n`,
    );
    expect(fake.containers.size).toBe(0);
    expect(fake.execs.some((exec) => isPiSession(exec.spec))).toBe(false);
    expect((await readdir(dir)).filter((name) => name.startsWith(".pi-sandbox-probe"))).toEqual([]);
  });

  it("removes the new container and leaves no marker when the share probe's exec throws", async () => {
    const fake = createFakeBackend({
      exec: (spec) => {
        if (isProbe(spec)) {
          throw new Error("exec transport closed");
        }

        return 0;
      },
    });
    const harness = await createHarness({ backend: () => fake.backend });
    const dir = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);

    expect(await run([], harness.deps)).not.toBe(0);
    expect(harness.stderr()).toContain("exec transport closed");
    expect(fake.containers.size).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a slug directory that is a symlink before any container exists", async () => {
    const { fake, harness, dir } = await sandboxWith();
    const elsewhere = join(harness.root, "elsewhere");

    await mkdir(elsewhere, { recursive: true });

    await mkdir(join(harness.hostAgentDir, "sessions"), { recursive: true });

    await symlink(elsewhere, dir);

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pi-sandbox: sessions: ${dir} is not a real directory`);
    expect(fake.containers.size).toBe(0);
  });

  it("sweeps links planted before the launch and during the run, and the agents subtree after the stop", async () => {
    const { harness, dir } = await sandboxWith(async (sessions) => {
      await writeFile(join(sessions, "run.jsonl"), header(harness.repoRoot));

      await mkdir(join(sessions, "run", "agents", "one"), { recursive: true });

      await symlink("/etc/passwd", join(sessions, "run", "agents", "one", "leak.jsonl"));

      await symlink("/etc/passwd", join(sessions, "late.jsonl"));

      await writeFile(join(sessions, "foreign.jsonl"), header("/etc"));
    });

    await mkdir(dir, { recursive: true });

    await symlink("/etc/hosts", join(dir, "early.jsonl"));

    expect(await run([], harness.deps)).toBe(0);
    const names = (await readdir(dir)).sort();

    expect(names.filter((name) => !name.startsWith("foreign.jsonl.rejected-"))).toEqual(["run", "run.jsonl"]);
    expect(names.some((name) => name.startsWith("foreign.jsonl.rejected-"))).toBe(true);
    expect(await readdir(join(dir, "run", "agents", "one"))).toEqual([]);
    expect(harness.stderr()).toContain(
      `pi-sandbox: sessions: ${join(dir, "foreign.jsonl")} names a cwd outside the repository; renamed to foreign.jsonl.rejected-`,
    );
  });

  it("leaves the agents subtree to a later sweep while another session keeps the container running", async () => {
    const { harness, dir } = await sandboxWith(async (sessions) => {
      await mkdir(join(sessions, "run", "agents"), { recursive: true });

      await symlink("/etc/passwd", join(sessions, "run", "agents", "leak.jsonl"));

      await symlink("/etc/passwd", join(sessions, "late.jsonl"));
    });

    await registerSession(harness.stateDir, {
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(await exists(join(dir, "late.jsonl"))).toBe(false);
    expect(await exists(join(dir, "run", "agents", "leak.jsonl"))).toBe(true);
  });

  it("does not sweep the agents subtree before the launch while another session is registered", async () => {
    const { harness, dir } = await sandboxWith();
    const leak = join(dir, "run", "agents", "leak.jsonl");

    await mkdir(join(dir, "run", "agents"), { recursive: true });

    await symlink("/etc/passwd", leak);

    await symlink("/etc/passwd", join(dir, "early.jsonl"));

    await registerSession(harness.stateDir, {
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(await exists(join(dir, "early.jsonl"))).toBe(false);
    expect(await exists(leak)).toBe(true);
  });

  it("still sweeps an existing session dir when sessions.host is off, and creates none", async () => {
    const off = await sandboxWith();
    const missing = await sandboxWith();

    await off.harness.writeJson(off.harness.userConfigFile, { sessions: { host: false } });

    await missing.harness.writeJson(missing.harness.userConfigFile, { sessions: { host: false } });

    await mkdir(join(off.dir, "run", "agents"), { recursive: true });

    await symlink("/etc/passwd", join(off.dir, "late.jsonl"));

    await symlink("/etc/passwd", join(off.dir, "run", "agents", "leak.jsonl"));

    await writeFile(join(off.dir, "forged.jsonl"), header("/etc"));

    expect(await run([], off.harness.deps)).toBe(0);
    expect(await run([], missing.harness.deps)).toBe(0);
    expect((await readdir(off.dir)).filter((name) => !name.startsWith("forged.jsonl.rejected-"))).toEqual([
      "run",
    ]);
    expect(await readdir(join(off.dir, "run", "agents"))).toEqual([]);
    expect(await exists(join(missing.harness.hostAgentDir, "sessions"))).toBe(false);
  });

  it("says an unknown PI_SANDBOX_SESSIONS_HOST value is ignored and keeps host sessions on", async () => {
    const { fake, harness, dir } = await sandboxWith();

    harness.deps.env.PI_SANDBOX_SESSIONS_HOST = "0";

    expect(await run([], harness.deps)).toBe(0);
    expect(containerSpec(fake)?.env.PI_CODING_AGENT_SESSION_DIR).toBe(dir);
    expect(harness.stderr()).toContain(
      'pi-sandbox: sessions: PI_SANDBOX_SESSIONS_HOST=0 is not "off" and is ignored\n',
    );
  });

  it("fixes a read-only session dir up and rejects the foreign session in it before the launch", async () => {
    const { fake, harness, dir } = await sandboxWith();

    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, "forged.jsonl"), header("/etc"));

    await chmod(dir, 0o500);

    expect(await run([], harness.deps)).toBe(0);
    expect((await readdir(dir)).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    expect(fake.containers.size).toBe(1);
  });

  it.skipIf(process.platform !== "darwin")(
    "refuses the launch and host pi when a foreign session can be neither renamed nor deleted",
    async () => {
      const { fake, harness, dir } = await sandboxWith();
      const pinned = join(dir, "pinned.jsonl");
      const message = `pi-sandbox: sessions: ${pinned} is a session file that names a cwd outside the repository and could be neither renamed nor deleted, in ${dir}; refusing to run pi`;

      await mkdir(dir, { recursive: true });

      await writeFile(pinned, header("/etc"));

      execFileSync("sh", ["-c", 'chflags uchg "$1"', "sh", pinned]);

      try {
        expect(await run([], harness.deps)).toBe(1);
        expect(harness.stderr()).toContain(message);
        expect(fake.containers.size).toBe(0);
        expect(fake.execs.some((exec) => isPiSession(exec.spec))).toBe(false);

        const bin = join(harness.root, "host-bin");

        await mkdir(bin, { recursive: true });

        await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n");

        await chmod(join(bin, "pi"), 0o755);

        harness.deps.env.PATH = bin;

        expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
        expect(harness.stderr().split(message)).toHaveLength(3);
        expect(harness.calls.some((call) => call.interactive)).toBe(false);
      } finally {
        execFileSync("sh", ["-c", 'chflags nouchg "$1"', "sh", pinned]);
      }
    },
  );

  it("recreates the container after sessions.host changes, on the repository network that still exists", async () => {
    const { fake, harness } = await sandboxWith();

    expect(await run([], harness.deps)).toBe(0);

    const [first] = [...fake.containers.keys()];

    await harness.writeJson(harness.userConfigFile, { sessions: { host: false } });

    expect(await run([], harness.deps)).toBe(0);

    const [second] = [...fake.containers.values()];
    const network = second?.spec?.network;

    expect(second?.summary.id).not.toBe(first);
    expect(fake.execs.filter((exec) => isPiSession(exec.spec))).toHaveLength(2);
    expect(network?.kind === "internal" && fake.networks.has(network.name)).toBe(true);
  });

  it("shows the session dir the container was created with in pi sandbox status", async () => {
    const on = await sandboxWith();
    const off = await sandboxWith();

    await off.harness.writeJson(off.harness.userConfigFile, { sessions: { host: false } });

    await run([], on.harness.deps);

    await run([], off.harness.deps);

    await run(["sandbox", "status"], on.harness.deps);

    await run(["sandbox", "status"], off.harness.deps);

    expect(on.harness.stdout()).toContain(`session dir: ${on.dir}\n`);
    expect(off.harness.stdout()).toContain("session dir: sandbox volume (sessions.host is off)\n");
  });
});

describe("pi --no-sandbox with host sessions", () => {
  const hostPiIn = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
    const bin = join(harness.root, "host-bin");

    await mkdir(bin, { recursive: true });

    await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n");

    await chmod(join(bin, "pi"), 0o755);

    harness.deps.env.PATH = bin;
  };

  it("sweeps the repository's session dir before host pi reads it, without a backend", async () => {
    const harness = await createHarness();
    const dir = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);

    await hostPiIn(harness);

    await mkdir(join(dir, "run", "agents"), { recursive: true });

    await symlink("/etc/passwd", join(dir, "late.jsonl"));

    await symlink("/etc/passwd", join(dir, "run", "agents", "leak.jsonl"));

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(await exists(join(dir, "late.jsonl"))).toBe(false);
    expect(await exists(join(dir, "run", "agents", "leak.jsonl"))).toBe(true);
  });

  it("sweeps the agents subtree too when the repository's container is not running", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const dir = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);

    await hostPiIn(harness);

    await mkdir(join(dir, "run", "agents"), { recursive: true });

    await symlink("/etc/passwd", join(dir, "run", "agents", "leak.jsonl"));

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(await exists(join(dir, "run", "agents", "leak.jsonl"))).toBe(false);
  });

  it("leaves the agents subtree alone while a sandboxed session of the repository is registered", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const dir = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);

    await hostPiIn(harness);

    await mkdir(join(dir, "run", "agents"), { recursive: true });

    await symlink("/etc/passwd", join(dir, "run", "agents", "leak.jsonl"));

    await registerSession(harness.stateDir, {
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(await exists(join(dir, "run", "agents", "leak.jsonl"))).toBe(true);
  });

  it("creates nothing on the host when the directory is missing", async () => {
    const harness = await createHarness();

    await hostPiIn(harness);

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(await exists(join(harness.hostAgentDir, "sessions"))).toBe(false);
  });
});
