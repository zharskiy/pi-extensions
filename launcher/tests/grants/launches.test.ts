import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endLaunch, liveLaunches, newLaunchId, registerLaunch } from "../../grants/index.ts";
import { stateLayout } from "../../shared/index.ts";

const REPO = "1".repeat(64);

const DEAD_PID = 999_999;

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-launches-"));
});

afterEach(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

const entry = (pid = process.pid, repoHash = REPO) => ({
  launchId: newLaunchId(),
  pid,
  repoHash,
  startedAt: 1,
});

describe("launches", () => {
  it("makes 16 hex launch ids", () => {
    expect(newLaunchId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newLaunchId()).not.toBe(newLaunchId());
  });

  it("counts live launches per repository and runs onLast only for the last one", async () => {
    const first = entry();
    const second = entry();
    const calls: string[] = [];

    expect(await registerLaunch(state.stateDir, first)).toBe(1);
    expect(await registerLaunch(state.stateDir, second)).toBe(2);
    expect(await registerLaunch(state.stateDir, entry(process.pid, "2".repeat(64)))).toBe(1);

    expect(
      await endLaunch(state.stateDir, {
        repoHash: REPO,
        launchId: first.launchId,
        onLast: async () => void calls.push("first"),
      }),
    ).toBe(1);
    expect(
      await endLaunch(state.stateDir, {
        repoHash: REPO,
        launchId: second.launchId,
        onLast: async () => void calls.push("second"),
      }),
    ).toBe(0);
    expect(calls).toEqual(["second"]);
  });

  it("ignores a session whose launcher pid is dead", async () => {
    const live = entry();

    await registerLaunch(state.stateDir, entry(DEAD_PID));

    await registerLaunch(state.stateDir, live);

    expect((await liveLaunches(state.stateDir, REPO)).map((session) => session.launchId)).toEqual([
      live.launchId,
    ]);
    expect(await liveLaunches(state.stateDir, REPO, () => false)).toEqual([]);

    const calls: string[] = [];

    await endLaunch(state.stateDir, {
      repoHash: REPO,
      launchId: live.launchId,
      onLast: async () => void calls.push("last"),
    });

    expect(calls).toEqual(["last"]);
  });

  it("deletes the entry of a dead launcher when another launch registers or ends", async () => {
    const directory = stateLayout(state.stateDir).repo(REPO).launches;
    const live = entry();
    const files = async () => (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();

    await registerLaunch(state.stateDir, entry(DEAD_PID));

    expect(await files()).toEqual([]);

    await registerLaunch(state.stateDir, live);

    await writeFile(join(directory, `${"a".repeat(16)}.json`), JSON.stringify(entry(DEAD_PID)));

    await endLaunch(state.stateDir, {
      repoHash: REPO,
      launchId: newLaunchId(),
      onLast: async () => undefined,
    });

    expect(await files()).toEqual([`${live.launchId}.json`]);
  });

  it("lists launches of every repository", async () => {
    await registerLaunch(state.stateDir, entry());

    await registerLaunch(state.stateDir, entry(process.pid, "2".repeat(64)));

    expect(await liveLaunches(state.stateDir)).toHaveLength(2);
  });

  it("takes over a lock left by a dead launcher", async () => {
    const first = entry();

    await registerLaunch(state.stateDir, first);

    await writeFile(stateLayout(state.stateDir).repo(REPO).lock, String(DEAD_PID));

    expect(await registerLaunch(state.stateDir, entry())).toBe(2);
  });

  it("takes over a lock without a readable pid at once", async () => {
    const first = entry();
    const lock = stateLayout(state.stateDir).repo(REPO).lock;

    await registerLaunch(state.stateDir, first);

    await writeFile(lock, "");

    expect(await registerLaunch(state.stateDir, entry())).toBe(2);
  });

  it("registers concurrent launches without losing any", async () => {
    const counts = await Promise.all([1, 2, 3, 4].map(() => registerLaunch(state.stateDir, entry())));

    expect([...counts].sort()).toEqual([1, 2, 3, 4]);
  });
});
