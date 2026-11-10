import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Backend } from "../../backend/index.ts";
import { LABELS } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { endLaunch, liveLaunches, newLaunchId, registerLaunch } from "../../grants/index.ts";
import {
  processMark,
  readCreatedDirs,
  readGitCreatedDirs,
  readPins,
  recordCreatedDirs,
  recordPins,
  repoRecordOf,
  sha256Hex,
  stateLayout,
  writeRepoRecord,
} from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, unreachable } from "./harness.ts";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const DEAD_PID = 2 ** 22 + 4321;

const leftRepo = async (harness: Awaited<ReturnType<typeof createHarness>>, name: string) => {
  const root = join(await realpath(await tempDir(name)), "repo");
  const hash = sha256Hex(root);
  const files = stateLayout(harness.stateDir).repo(hash);
  const hooks = join(root, ".git", "hooks");
  const mountPoint = join(root, "node_modules");

  await mkdir(hooks, { recursive: true });

  await mkdir(mountPoint, { recursive: true });

  await harness.writeJson(files.record, { root });

  await harness.writeJson(files.created, [hooks, mountPoint]);

  await harness.writeJson(files.pins, [
    { path: join(root, ".git", "commondir"), gitCommonDir: join(root, ".git") },
  ]);

  return { root, hash, files, hooks, mountPoint };
};

describe("the sweep of a repository's git protections", () => {
  it("keeps a created hooks dir while another sandbox shares the git dir, and removes it once none does", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const left = await leftRepo(harness, "shared-git");
    const worktree = {
      launchId: newLaunchId(),
      repoHash: "c".repeat(64),
      startedAt: 1,
      ...(await processMark()),
    };

    await registerLaunch(harness.stateDir, worktree);

    const other = fake.addContainer({
      name: "pi-sandbox-worktree",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.repoHash]: worktree.repoHash,
        [LABELS.gitCommonDir]: join(left.root, ".git"),
      },
      state: "running",
      image: "x",
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await exists(left.hooks)).toBe(true);
    expect(await exists(left.mountPoint)).toBe(false);
    expect(await readCreatedDirs(harness.stateDir, left.hash)).toEqual([left.hooks]);

    fake.containers.delete(other);

    await endLaunch(harness.stateDir, { ...worktree, onLast: async () => undefined });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await exists(left.hooks)).toBe(false);
    expect(await readCreatedDirs(harness.stateDir, left.hash)).toEqual([]);
  });

  it("keeps the pins and the created git dirs when the engine side of the removal fails", async () => {
    const fake = createFakeBackend();
    const backend: Backend = {
      ...fake.backend,
      removeRepoNetwork: async () => {
        throw new Error("engine busy");
      },
    };
    const harness = await createHarness({ backend: () => backend });
    const left = await leftRepo(harness, "failed-engine");

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain("the sandbox containers were not removed: engine busy");
    expect(await exists(left.hooks)).toBe(true);
    expect(await exists(left.mountPoint)).toBe(false);
    expect(await readPins(harness.stateDir, left.hash)).toHaveLength(1);
  });
});

describe("the sweep of what is left in the state dir", () => {
  it("keeps a repository whose recorded root was a mount point when the root is missing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const parent = await realpath(await tempDir("volumes"));
    const root = join(parent, "Projects");
    const hash = sha256Hex(root);
    const files = stateLayout(harness.stateDir).repo(hash);

    await harness.writeJson(files.record, { root, mountPoint: true });

    await fake.backend.ensureVolume("pi-sandbox-agent-volume-root", {
      [LABELS.repoHash]: hash,
      [LABELS.repoRoot]: root,
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await repoRecordOf(harness.stateDir, hash)).toEqual({ root, mountPoint: true });
    expect(fake.volumes.has("pi-sandbox-agent-volume-root")).toBe(true);
  });

  it("keeps a repository whose root cannot be checked for another reason than it is missing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const locked = await realpath(await tempDir("locked"));
    const root = join(locked, "inner", "repo");
    const hash = sha256Hex(root);
    const files = stateLayout(harness.stateDir).repo(hash);

    await mkdir(root, { recursive: true });

    await harness.writeJson(files.record, { root });

    await chmod(join(locked, "inner"), 0o600);

    try {
      expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
      expect(await repoRecordOf(harness.stateDir, hash)).toEqual({ root, mountPoint: false });
    } finally {
      await chmod(join(locked, "inner"), 0o700);
    }
  });

  it("records a repository root that is a mount point", async () => {
    const harness = await createHarness();
    const hash = sha256Hex("/dev");

    await writeRepoRecord(harness.stateDir, hash, "/dev");

    expect(await repoRecordOf(harness.stateDir, hash)).toEqual({ root: "/dev", mountPoint: true });
    expect(
      JSON.parse(await readFile(stateLayout(harness.stateDir).repo(sha256Hex("/dev")).record, "utf8")),
    ).toEqual({ root: "/dev", mountPoint: true });
  });

  it("removes the entry a killed launcher left", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const hash = sha256Hex(harness.repoRoot);
    const entry = join(stateLayout(harness.stateDir).repo(hash).launches, `${newLaunchId()}.json`);

    await harness.writeJson(stateLayout(harness.stateDir).repo(hash).record, { root: harness.repoRoot });

    await harness.writeJson(entry, {
      launchId: "0".repeat(16),
      pid: DEAD_PID,
      boot: 1,
      start: "never",
      repoHash: hash,
      startedAt: 1,
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await exists(entry)).toBe(false);
    expect(await liveLaunches(harness.stateDir, hash)).toEqual([]);
  });

  it("forgets a repository it knows only from engine labels once its sandbox is removed", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "d".repeat(64);
    const id = fake.addContainer({
      name: `pi-sandbox-${orphan.slice(0, 12)}`,
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: orphan },
      state: "running",
      image: "x",
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(await exists(stateLayout(harness.stateDir).repo(orphan).directory)).toBe(false);
  });
});

describe("the recorded lists", () => {
  it("refuses to overwrite a pin list it cannot parse, so no recorded pin is forgotten", async () => {
    const harness = await createHarness();
    const hash = sha256Hex(harness.repoRoot);
    const file = stateLayout(harness.stateDir).repo(hash).pins;

    await mkdir(join(file, ".."), { recursive: true });

    await writeFile(file, "[{ broken");

    await expect(
      recordPins(harness.stateDir, hash, [{ path: "/repo/.git/commondir", gitCommonDir: "/repo/.git" }]),
    ).rejects.toThrow(/invalid JSON/);
    expect(await readFile(file, "utf8")).toBe("[{ broken");

    await writeFile(file, "{}");

    await expect(readPins(harness.stateDir, hash)).rejects.toThrow(/not a list/);
  });
});

const hooksPathRepo = async (harness: Awaited<ReturnType<typeof createHarness>>, name: string) => {
  const root = join(await realpath(await tempDir(name)), "repo");
  const hash = sha256Hex(root);
  const hooksPath = join(root, ".githooks");
  const mountPoint = join(root, "node_modules");

  await mkdir(hooksPath, { recursive: true });

  await mkdir(mountPoint, { recursive: true });

  await harness.writeJson(stateLayout(harness.stateDir).repo(hash).record, { root });

  await recordCreatedDirs(harness.stateDir, hash, [mountPoint]);

  return { root, hash, hooksPath, mountPoint };
};

const sharingSandbox = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
  fake: ReturnType<typeof createFakeBackend>,
  gitCommonDir: string,
) => {
  const launch = {
    launchId: newLaunchId(),
    repoHash: "e".repeat(64),
    startedAt: 1,
    ...(await processMark()),
  };

  await registerLaunch(harness.stateDir, launch);

  fake.addContainer({
    name: "pi-sandbox-nested",
    labels: {
      [LABELS.managed]: "true",
      [LABELS.repoHash]: launch.repoHash,
      [LABELS.gitCommonDir]: gitCommonDir,
    },
    state: "running",
    image: "x",
  });
};

describe("the created dirs recorded as git protection", () => {
  it("keeps a recorded core.hooksPath dir in the working tree while the engine does not answer", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => unreachable(fake.backend) });
    const repo = await hooksPathRepo(harness, "hooks-path");

    await recordCreatedDirs(harness.stateDir, repo.hash, [repo.hooksPath], {
      gitCommonDir: join(repo.root, ".git"),
    });

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await exists(repo.hooksPath)).toBe(true);
    expect(await exists(repo.mountPoint)).toBe(false);
    expect(await readCreatedDirs(harness.stateDir, repo.hash)).toEqual([repo.hooksPath]);
    expect(await readGitCreatedDirs(harness.stateDir, repo.hash)).toEqual([
      { dir: repo.hooksPath, gitCommonDir: join(repo.root, ".git") },
    ]);
  });

  it("checks a recorded dir against its own repository's git dir, not another pinned one", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = await hooksPathRepo(harness, "nested-owner");
    const nested = join(repo.root, "nested", ".git");

    await harness.writeJson(stateLayout(harness.stateDir).repo(repo.hash).pins, [
      { path: join(repo.root, "other", ".git", "commondir"), gitCommonDir: join(repo.root, "other", ".git") },
    ]);

    await recordCreatedDirs(harness.stateDir, repo.hash, [repo.hooksPath], { gitCommonDir: nested });

    await sharingSandbox(harness, fake, nested);

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await exists(repo.hooksPath)).toBe(true);
  });

  it("keeps an entry of the old form, whose owner is unknown, while the repository has no pin", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = await hooksPathRepo(harness, "old-form");

    await recordCreatedDirs(harness.stateDir, repo.hash, [repo.hooksPath]);

    await harness.writeJson(
      join(stateLayout(harness.stateDir).repo(repo.hash).directory, "created-git.json"),
      [repo.hooksPath],
    );

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await exists(repo.hooksPath)).toBe(true);
    expect(await exists(repo.mountPoint)).toBe(false);
    expect(await readGitCreatedDirs(harness.stateDir, repo.hash)).toEqual([{ dir: repo.hooksPath }]);
  });

  it("keeps an entry whose owner is unknown while any pinned git dir of the repository is in use", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = await hooksPathRepo(harness, "unknown-owner");
    const gitCommonDir = join(repo.root, ".git");

    await recordCreatedDirs(harness.stateDir, repo.hash, [repo.hooksPath]);

    await harness.writeJson(stateLayout(harness.stateDir).repo(repo.hash).pins, [
      { path: join(gitCommonDir, "commondir"), gitCommonDir },
    ]);

    await harness.writeJson(
      join(stateLayout(harness.stateDir).repo(repo.hash).directory, "created-git.json"),
      [repo.hooksPath],
    );

    await sharingSandbox(harness, fake, gitCommonDir);

    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await exists(repo.hooksPath)).toBe(true);
  });
});
