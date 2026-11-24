import { lstat, lutimes, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepOrphans } from "../../cli/sweep.ts";
import { newLaunchId, registerLaunch } from "../../grants/index.ts";
import { isWithin, processMark, sha256Hex, stateLayout } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, sweepNow } from "./harness.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type Harness = Awaited<ReturnType<typeof createHarness>>;

const defaultHarness = () =>
  createHarness({ backend: () => createFakeBackend().backend, defaultStateDir: true });

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const ageTo = async (harness: Harness, path: string, days: number) => {
  const seconds = (harness.deps.now() - days * DAY_MS) / 1000;

  await utimes(path, seconds, seconds);
};

const plant = async (harness: Harness, path: string, days: number) => {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, path.endsWith(".json") ? "{}" : "");

  await ageTo(harness, path, days);
};

const plantFolder = async (harness: Harness, path: string, days: number) => {
  await plant(harness, join(path, "inside"), days);

  await ageTo(harness, path, days);
};

const knownRepo = async (harness: Harness) => {
  const hash = sha256Hex(harness.repoRoot);
  const files = stateLayout(harness.stateDir).repo(hash);

  await harness.writeJson(files.record, { root: harness.repoRoot });

  return { hash, files };
};

const leavesOf = (value: unknown, name: string): string[] => {
  if (typeof value === "string") {
    return [value];
  }

  if (typeof value === "function") {
    return leavesOf(value(name), name);
  }

  return typeof value === "object" && value !== null
    ? Object.values(value).flatMap((inner) => leavesOf(inner, name))
    : [];
};

describe("the daily collection of state entries the layout does not name", () => {
  it("removes an unknown file and folder at the top and says so", async () => {
    const harness = await defaultHarness();
    const file = join(harness.stateDir, "seen-old.json");
    const folder = join(harness.stateDir, "old-cache");

    await plant(harness, file, 2);

    await plantFolder(harness, folder, 2);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(file)).toBe(false);
    expect(await exists(folder)).toBe(false);
    expect(harness.stdout()).toContain("removed state entry seen-old.json\n");
    expect(harness.stdout()).toContain("removed state entry old-cache\n");
  });

  it("removes an unknown entry inside a known repository's folder and keeps the named ones", async () => {
    const harness = await defaultHarness();
    const repo = await knownRepo(harness);
    const unknown = join(repo.files.directory, "proxy");

    await plantFolder(harness, unknown, 2);

    await plant(harness, repo.files.legacy.render, 2);

    await plant(harness, join(repo.files.legacy.sync, "old.json"), 2);

    await ageTo(harness, repo.files.record, 2);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(unknown)).toBe(false);
    expect(await exists(join(repo.files.legacy.sync, "old.json"))).toBe(true);
    expect(await exists(repo.files.record)).toBe(true);
    expect(await exists(repo.files.legacy.render)).toBe(true);
    expect(harness.stdout()).toContain(`removed state entry ${join("repos", repo.hash, "proxy")}\n`);
  });

  it("keeps every path the layout names, however old", async () => {
    const harness = await defaultHarness();
    const repo = await knownRepo(harness);
    const layout = stateLayout(harness.stateDir);
    const ownRemovers = [layout.locks, layout.build];
    const named = leavesOf(layout, repo.hash);
    const planted = named.filter(
      (path) => path !== repo.files.record && !ownRemovers.some((owned) => isWithin(path, owned)),
    );
    const leaves = planted.filter(
      (path) => !planted.some((other) => other !== path && isWithin(other, path)),
    );

    await Promise.all(
      leaves.map((path) =>
        path === layout.launches ? plantFolder(harness, path, 2) : plant(harness, path, 2),
      ),
    );

    await Promise.all(planted.map((path) => ageTo(harness, path, 2)));

    await registerLaunch(harness.stateDir, {
      launchId: newLaunchId(),
      repoHash: repo.hash,
      startedAt: 1,
      ...(await processMark()),
    });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect((await Promise.all(planted.map(exists))).every(Boolean)).toBe(true);
    expect(await exists(repo.files.record)).toBe(true);
    expect(harness.stdout()).not.toContain("removed state entry");
  });

  it("keeps fresh unknown entries, such as an atomic write or a lock draft in flight", async () => {
    const harness = await defaultHarness();
    const repo = await knownRepo(harness);
    const temporary = join(harness.stateDir, `grants.json.${process.pid}.0a1b2c3d.tmp`);
    const draft = `${repo.files.legacy.renderLock}.draft.${process.pid}.0a1b2c3d`;
    const work = join(stateLayout(harness.stateDir).ca, "work-abc123");

    await plant(harness, temporary, 0);

    await plant(harness, draft, 0);

    await plantFolder(harness, work, 0);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(temporary)).toBe(true);
    expect(await exists(draft)).toBe(true);
    expect(await exists(work)).toBe(true);
  });

  it("removes an unknown symbolic link itself and never what it points to", async () => {
    const harness = await defaultHarness();
    const outside = await tempDir("state-link-target");
    const target = join(outside, "kept.txt");
    const link = join(harness.stateDir, "linked");

    await writeFile(target, "kept");

    await symlink(outside, link);

    const seconds = (harness.deps.now() - 2 * DAY_MS) / 1000;

    await lutimes(link, seconds, seconds);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(link)).toBe(false);
    expect(await exists(target)).toBe(true);
  });

  it("does not run again on the day it ran", async () => {
    const harness = await defaultHarness();
    const file = join(harness.stateDir, "old.json");

    await plant(harness, file, 2);

    await harness.writeJson(stateLayout(harness.stateDir).gcRecord, { lastRun: harness.deps.now() });

    await sweepOrphans(harness.deps, harness.deps.backend());

    expect(await exists(file)).toBe(true);
  });

  it("leaves a state dir that PINATA_STATE_DIR moves alone", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });
    const file = join(harness.stateDir, "old.json");

    await plant(harness, file, 2);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(file)).toBe(true);
    expect(await exists(stateLayout(harness.stateDir).gcRecord)).toBe(true);
  });

  it("never descends into a walked folder that is a symbolic link", async () => {
    const harness = await defaultHarness();
    const outside = await tempDir("state-walked-link");
    const target = join(outside, "sync", "old.json");
    const link = join(stateLayout(harness.stateDir).repos, sha256Hex("elsewhere"));

    await plant(harness, target, 2);

    await mkdir(dirname(link), { recursive: true });

    await symlink(outside, link);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(target)).toBe(true);
  });

  it("removes nothing and records no run while the engine does not answer", async () => {
    const harness = await createHarness({ defaultStateDir: true });
    const file = join(harness.stateDir, "old.json");

    await plant(harness, file, 2);

    await sweepNow(harness.deps);

    expect(await exists(file)).toBe(true);
    expect(await exists(stateLayout(harness.stateDir).gcRecord)).toBe(false);
  });

  it("keeps old unknown entries inside the folders it does not look into", async () => {
    const harness = await defaultHarness();
    const layout = stateLayout(harness.stateDir);
    const unknown = [layout.locks, layout.launches, layout.providerHostsDir].map((folder) =>
      join(folder, "unknown.txt"),
    );

    await Promise.all(unknown.map((path) => plant(harness, path, 2)));

    expect(await sweepNow(harness.deps)).toBe(0);
    expect((await Promise.all(unknown.map(exists))).every(Boolean)).toBe(true);
  });

  it("removes a render folder and a stray in repos/ with no repository known", async () => {
    const harness = await defaultHarness();
    const layout = stateLayout(harness.stateDir);
    const render = layout.repo(sha256Hex("gone")).legacy.render;
    const stray = join(layout.repos, "stray.json");

    await plantFolder(harness, render, 2);

    await plant(harness, stray, 2);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await exists(render)).toBe(false);
    expect(await exists(stray)).toBe(false);
    expect(await exists(layout.renders)).toBe(true);
  });
});
