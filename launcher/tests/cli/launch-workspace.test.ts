import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathsOf } from "../../cli/deps.ts";
import { sandboxReachOf } from "../../cli/host-pi.ts";
import { run, runPinata } from "../../cli/index.ts";
import { repoHash, repoRecordOf } from "../../shared/index.ts";
import { sandboxWriteRoots } from "../../workspace/index.ts";
import { createFakeBackend, createHarness, type HarnessOptions } from "./harness.ts";

const overlayNotice = (places: string) =>
  `pinata: node_modules overlaid in ${places}; the host copies are hidden; set mounts.autoOverlays=false to keep them`;

const CAPPED_NOTICE =
  "pinata: more than 512 build output directories; overlays disabled, the host copies are used";

const occurrences = (text: string, line: string) => text.split("\n").filter((entry) => entry === line).length;

interface Layout {
  repos: string[];
  lockfiles?: string[];
}

const workspaceHarness = async (layout: Layout, options: HarnessOptions = {}) => {
  const harness = await createHarness({ workspaceRoot: "work", ...options });
  const work = join(harness.root, "work");

  mkdirSync(work, { recursive: true });

  layout.repos.forEach((repo) => {
    mkdirSync(join(work, repo, ".git", "hooks"), { recursive: true });
  });

  (layout.lockfiles ?? []).forEach((file) => {
    mkdirSync(join(work, file, ".."), { recursive: true });

    writeFileSync(join(work, file), "{}");
  });

  return { ...harness, work, deps: { ...harness.deps, cwd: join(work, "a") } };
};

const notGitNotice = (folder: string) =>
  `pinata: ${folder} is not in a git repository; build output is not overlaid, the host copies are used`;

describe("pi in a project of the workspace root", () => {
  it("binds the whole root read-write, nothing narrower, and overlays only the started project", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json", "b/package-lock.json"] },
      { backend: () => fake.backend },
    );

    await mkdir(join(harness.work, "a", "src"));

    expect(await run([], { ...harness.deps, cwd: join(harness.work, "a", "src") })).toBe(0);

    const mounts = fake.created[0]?.spec?.mounts ?? [];
    const inRoot = mounts.filter((mount) => mount.target.startsWith(harness.work));

    expect(inRoot).toEqual([
      { source: harness.work, target: harness.work, readOnly: false, kind: "bind" },
      expect.objectContaining({ target: join(harness.work, "a", "node_modules"), kind: "volume" }),
    ]);
    expect(occurrences(harness.stderr(), overlayNotice("1 directory"))).toBe(1);
  });

  it("launches in a folder of the root outside git with no overlays and one notice", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a"], lockfiles: ["notes/package-lock.json"] },
      { backend: () => fake.backend },
    );
    const notes = join(harness.work, "notes");

    expect(await run([], { ...harness.deps, cwd: notes })).toBe(0);
    expect(await run([], { ...harness.deps, cwd: harness.work })).toBe(0);

    const mounts = fake.created.flatMap((created) => created.spec?.mounts ?? []);

    expect(
      mounts.filter((mount) => mount.kind === "volume" && mount.target.startsWith(harness.work)),
    ).toEqual([]);
    expect(occurrences(harness.stderr(), notGitNotice(notes))).toBe(1);
    expect(occurrences(harness.stderr(), notGitNotice(harness.work))).toBe(1);
    expect(fake.created[0]?.spec?.workdir).toBe(notes);
  });

  it("refuses a project whose git dir lies outside the root before it starts the VM", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: [] }, { backend: () => fake.backend });
    const gitDir = join(harness.root, "elsewhere", ".git", "worktrees", "wt");
    const worktree = join(harness.work, "wt");

    await mkdir(gitDir, { recursive: true });
    await mkdir(worktree, { recursive: true });

    await writeFile(join(gitDir, "commondir"), "../..\n");

    await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    expect(await run([], { ...harness.deps, cwd: worktree })).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: git: the git dir ${gitDir} of ${worktree} is outside the workspace root (workspaceRoot: ${harness.work})`,
    );
    expect(harness.calls.filter((call) => call.file === "colima")).toEqual([]);
    expect(fake.created).toEqual([]);
  });

  it("records the root with the project, so the old root stays sandbox-writable once the config changes", async () => {
    const harness = await workspaceHarness({ repos: ["a"] }, { backend: () => createFakeBackend().backend });
    const project = join(harness.work, "a");
    const configFile = pathsOf(harness.deps).userConfigFile;
    const moved = join(harness.root, "moved");

    expect(await run([], harness.deps)).toBe(0);
    expect(await repoRecordOf(harness.stateDir, repoHash(project))).toEqual({
      root: project,
      workspaceRoot: harness.work,
    });

    await mkdir(moved);

    await writeFile(configFile, JSON.stringify({ workspaceRoot: moved }));

    expect(await sandboxWriteRoots(await sandboxReachOf(harness.deps))).toEqual([
      moved,
      project,
      harness.work,
    ]);

    await writeFile(configFile, "{ not json");

    expect(await sandboxWriteRoots(await sandboxReachOf(harness.deps))).toEqual([project, harness.work]);
  });

  it("runs status and restart in a folder outside git", async () => {
    const harness = await workspaceHarness({ repos: [] }, { backend: () => createFakeBackend().backend });
    const deps = { ...harness.deps, cwd: harness.work };

    expect(await runPinata(["status"], deps)).toBe(0);
    expect(harness.stdout()).toContain(`folder: ${harness.work}\n`);
    expect(await runPinata(["restart"], deps)).toBe(0);
    expect(harness.stdout()).toContain("ok Created the sandbox VM in");
  });

  it("refuses the home and a folder under a dotfiles home, and still runs status there", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: [] }, { backend: () => fake.backend });
    const home = harness.deps.home;
    const project = join(home, "code", "project");
    const refusal = `pinata: pi may not start in ${home}, a protected folder, refusing`;

    harness.deps.cwd = home;

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(refusal);

    await mkdir(join(home, ".git"));
    await mkdir(project, { recursive: true });

    harness.deps.cwd = project;

    expect(await run([], harness.deps)).toBe(1);
    expect(occurrences(harness.stderr(), refusal)).toBe(2);
    expect(await runPinata(["status"], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
  });
});

describe("the overlay notice", () => {
  it("prints the notice once per value, again only when the overlays change", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json"] },
      { backend: () => fake.backend },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), overlayNotice("1 directory"))).toBe(1);

    await writeFile(join(harness.work, "a", "Cargo.lock"), "");

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      "pinata: node_modules, target overlaid in 2 directories; the host copies are hidden",
    );
  });

  it("counts several directories in the plural", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json", "a/web/pnpm-lock.yaml", "a/tools/yarn.lock"] },
      { backend: () => fake.backend },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), overlayNotice("3 directories"))).toBe(1);
  });

  it("says overlays are off when there are more than 512", async () => {
    const fake = createFakeBackend();
    const lockfiles = Array.from({ length: 513 }, (_, index) => `a/p${index}/package-lock.json`);
    const harness = await workspaceHarness({ repos: ["a", "b"], lockfiles }, { backend: () => fake.backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), CAPPED_NOTICE)).toBe(1);
    expect(harness.stderr()).not.toContain("overlaid in");
  });

  it("stays silent when mounts.autoOverlays is off, in git or outside it", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json"] },
      { backend: () => fake.backend },
    );

    await harness.writeJson(harness.userConfigFile, { mounts: { autoOverlays: false } });

    expect(await run([], harness.deps)).toBe(0);
    expect(await run([], { ...harness.deps, cwd: harness.work })).toBe(0);
    expect(harness.stderr()).not.toContain("overlaid");
  });

  it("stays silent without overlay markers", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "b"] }, { backend: () => fake.backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("overlaid in");
  });
});
