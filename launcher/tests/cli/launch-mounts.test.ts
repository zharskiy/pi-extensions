import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmPath } from "../../backend/index.ts";
import { run, runPinata } from "../../cli/index.ts";
import { hostSessionsDir } from "../../workspace/index.ts";
import { git } from "../support/git.ts";
import { createFakeBackend, createHarness, renderDirOf } from "./harness.ts";

const commandsOf = (fake: ReturnType<typeof createFakeBackend>) =>
  fake.execs.map((exec) => exec.spec.command);

const isPi = (command: string[]) => command.includes("pi");

const appInRoot = async (fake: ReturnType<typeof createFakeBackend>, workspaceRoot: string) => {
  const app = { path: "" };
  const harness = await createHarness({
    backend: () => fake.backend,
    workspaceRoot,
    respond: (call) =>
      call.file === "git" && call.args.includes("--show-toplevel")
        ? { stdout: `${app.path}\n.git\n` }
        : undefined,
  });
  const root = join(harness.root, workspaceRoot);

  app.path = join(root, "app");

  await mkdir(join(app.path, ".git", "hooks"), { recursive: true });

  return { harness, root, app: app.path, deps: { ...harness.deps, cwd: app.path } };
};

describe("mounts.binds", () => {
  it("mounts a bind read-only at its target and asks the VM to share its source read-only", async () => {
    const fake = createFakeBackend();
    const asked: { needs?: VmPath[] } = {};
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          reconcile: async ({ needs }) => {
            asked.needs = needs;
          },
        },
      }),
    });
    const source = join(harness.root, "reference");

    await mkdir(source);

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source, target: "/etc/reference" }] },
    });

    expect(await run([], harness.deps)).toBe(0);

    const [container] = fake.created;

    expect(container?.spec?.mounts.find((mount) => mount.target === "/etc/reference")).toEqual({
      source,
      target: "/etc/reference",
      readOnly: true,
      kind: "bind",
    });
    expect(asked.needs).toContainEqual({ path: source, writable: false });
  });

  it("refuses a bind source that does not exist before it calls the engine", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const source = join(harness.root, "missing");

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source, target: "/etc/reference" }] },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pinata: config: mounts.binds[0].source: ${source} does not exist`);
    expect(fake.created).toEqual([]);
    expect(fake.execs).toEqual([]);
  });

  it("shares a bind source apart from the workspace root", async () => {
    const fake = createFakeBackend();
    const asked: { shares?: string[] } = {};
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          reconcile: async ({ shares }) => {
            asked.shares = shares?.map((share) => `${share.location} ${share.writable ? "rw" : "ro"}`);
          },
        },
      }),
    });
    const apart = join(harness.root, "reference");

    await mkdir(apart);

    await harness.writeJson(harness.userConfigFile, {
      workspaceRoot: harness.repoRoot,
      mounts: { binds: [{ source: apart, target: "/etc/reference" }] },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked.shares).toContain(`${apart} ro`);
    expect(asked.shares).toContain(`${harness.repoRoot} rw`);
  });

  it("refuses a bind source inside the workspace root, the repository included, before it calls the engine", async () => {
    const fake = createFakeBackend();
    const { harness, root, app, deps } = await appInRoot(fake, "projects");
    const inRepo = join(app, "docs");
    const inRoot = join(root, "lib");

    await Promise.all([mkdir(inRepo), mkdir(inRoot)]);

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source: inRepo, target: "/etc/docs" }] },
    });

    expect(await run([], deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: config: mounts.binds[0].source: ${inRepo} overlaps ${root}, which the sandbox already mounts`,
    );

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source: inRoot, target: "/etc/lib" }] },
    });

    expect(await run([], deps)).toBe(1);
    expect(harness.stderr()).toContain(`pinata: config: mounts.binds[0].source: ${inRoot} overlaps ${root}`);
    expect(fake.created).toEqual([]);
  });

  it("refuses a bind inside the git common dir of a linked worktree, which the workspace root holds", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend, workspaceRoot: "worktrees" });
    const main = join(harness.root, "worktrees", "main");
    const linked = { root: join(harness.root, "worktrees", "linked"), commonDir: join(main, ".git") };

    await mkdir(main, { recursive: true });

    await git(main, ["init", "--quiet"]);

    await git(main, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

    await git(main, ["worktree", "add", "--quiet", linked.root]);

    const inside = join(linked.commonDir, "reference");

    await mkdir(inside);

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source: inside, target: "/etc/reference" }] },
    });

    expect(await run([], { ...harness.deps, cwd: linked.root })).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: config: mounts.binds[0].source: ${inside} overlaps ${join(harness.root, "worktrees")}, which the sandbox already mounts`,
    );
    expect(fake.created).toEqual([]);
  });

  it("refuses a bind inside the host sessions dir", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const sessions = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);
    const inside = join(sessions, "reference");

    await mkdir(inside, { recursive: true });

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source: inside, target: "/etc/reference" }] },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: config: mounts.binds[0].source: ${inside} overlaps pi's directory (${join(harness.deps.home, ".pi")})`,
    );
    expect(fake.created).toEqual([]);
  });

  it("refuses a bind source swapped for a link between its check and the container create", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        vm: {
          ...fake.backend.vm,
          reconcile: async () => {
            await rename(source, `${source}.moved`);

            await symlink(harness.repoRoot, source);
          },
        },
      }),
    });
    const source = join(harness.root, "reference");

    await mkdir(source);

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source, target: "/etc/reference" }] },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: config: mounts.binds[0].source: ${source} changed while pi was starting, refusing`,
    );
    expect(fake.created).toEqual([]);
  });

  it("refuses a file bind whose folder holds the workspace root, as colima refuses nested shares", async () => {
    const fake = createFakeBackend();
    const { harness, root, deps } = await appInRoot(fake, join("other", "inner"));
    const other = join(root, "..");
    const file = join(other, "tool.conf");

    await writeFile(file, "x");

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source: file, target: "/etc/tool.conf" }] },
    });

    expect(await run([], deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: config: mounts.binds: the sandbox VM would share ${other} for a bind source, which holds the share ${root}, and colima refuses nested shares`,
    );
    expect(fake.created).toEqual([]);
  });
});

describe("setup", () => {
  it("runs each command in the agent container after the hand-over and before pi, as pi runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      mounts: { volumes: ["/opt/data"] },
      setup: [
        ["npm", "ci"],
        ["sh", "-c", "make init"],
      ],
    });

    expect(await run([], harness.deps)).toBe(0);

    const commands = commandsOf(fake);
    const handover = commands.findIndex(
      (command) => command[0] === "/bin/sh" && command[2]?.startsWith("/bin/chown") === true,
    );
    const first = commands.findIndex((command) => command[0] === "npm");
    const second = commands.findIndex((command) => command[0] === "sh" && command[2] === "make init");
    const pi = commands.findIndex(isPi);
    const setupExec = fake.execs[first]?.spec;
    const piExec = fake.execs[pi]?.spec;

    expect(handover).toBeGreaterThanOrEqual(0);
    expect([handover < first, first < second, second < pi]).toEqual([true, true, true]);
    expect(setupExec?.workdir).toBe(harness.repoRoot);
    expect(setupExec?.user).toBeUndefined();
    expect(setupExec?.containerId).toBe(piExec?.containerId);
    expect(Object.keys(setupExec?.env ?? {}).sort()).toEqual(Object.keys(piExec?.env ?? {}).sort());
    expect(fake.execs[first]?.tty).toBe(false);
    expect(harness.stderr()).toContain("pinata: setup: npm ci\n");
  });

  it("stops the launch when a command fails, naming it and its exit code, and never starts pi", async () => {
    const fake = createFakeBackend({ exec: (spec) => (spec.command[0] === "make" ? 2 : undefined) });
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      setup: [
        ["make", "init"],
        ["npm", "ci"],
      ],
    });

    expect(await run([], harness.deps)).not.toBe(0);
    expect(harness.stderr()).toContain("pinata: setup: make init exited with code 2, so pi did not start\n");
    expect(harness.stderr()).toContain("hint: fix or remove that command in setup");
    expect(commandsOf(fake).some(isPi)).toBe(false);
    expect(commandsOf(fake).some((command) => command[0] === "npm")).toBe(false);
    expect(fake.containers.size).toBe(0);
  });

  it("is skipped by the doctor, with the binds", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source: join(harness.root, "missing"), target: "/etc/reference" }] },
      setup: [["make", "init"]],
    });

    await runPinata(["doctor"], harness.deps);

    expect(commandsOf(fake).some((command) => command[0] === "make")).toBe(false);
    expect(
      fake.created.some((created) => created.spec?.mounts.some((mount) => mount.target === "/etc/reference")),
    ).toBe(false);
  });

  it("keeps the configured binds in the status file when the doctor's probe skips mounting them", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const statusOf = async () =>
      JSON.parse(await readFile(join(renderDirOf(harness), "tools", "status.json"), "utf8"));

    await mkdir(join(harness.root, "reference"));

    await harness.writeJson(harness.userConfigFile, {
      mounts: { binds: [{ source: join(harness.root, "reference"), target: "/etc/reference" }] },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect((await statusOf()).binds).toEqual([{ target: "/etc/reference" }]);

    await runPinata(["doctor"], harness.deps);

    expect((await statusOf()).binds).toEqual([{ target: "/etc/reference" }]);
  });
});
