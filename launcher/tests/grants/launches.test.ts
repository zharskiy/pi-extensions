import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endLaunch, liveLaunches, newLaunchId, registerLaunch } from "../../grants/index.ts";
import { bootTime, stateLayout } from "../../shared/index.ts";

const REPO = "1".repeat(64);

const DEAD_PID = 999_999;

const state = { stateDir: "", beats: [] as Array<() => void> };

beforeEach(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-launches-"));
});

afterEach(async () => {
  state.beats.splice(0).forEach((stop) => {
    stop();
  });

  await rm(state.stateDir, { recursive: true, force: true });
});

const entry = (pid = process.pid, repoHash = REPO) => ({
  launchId: newLaunchId(),
  pid,
  boot: bootTime(),
  repoHash,
  startedAt: 1,
});

const register = async (launch: ReturnType<typeof entry>) => {
  const registered = await registerLaunch(state.stateDir, launch);

  state.beats.push(registered.stopHeartbeat);

  return registered.live;
};

describe("launches", () => {
  it("makes 16 hex launch ids", () => {
    expect(newLaunchId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newLaunchId()).not.toBe(newLaunchId());
  });

  it("counts live launches per repository and runs onLast only for the last one", async () => {
    const first = entry();
    const second = entry();
    const calls: string[] = [];

    expect(await register(first)).toBe(1);
    expect(await register(second)).toBe(2);
    expect(await register(entry(process.pid, "2".repeat(64)))).toBe(1);

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

    await register(entry(DEAD_PID));

    await register(live);

    expect((await liveLaunches(state.stateDir, REPO)).map((session) => session.launchId)).toEqual([
      live.launchId,
    ]);
    expect(await liveLaunches(state.stateDir, REPO, Date.now() + 120_000)).toEqual([]);

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

    await register(entry(DEAD_PID));

    expect(await files()).toEqual([]);

    await register(live);

    await writeFile(join(directory, `${"a".repeat(16)}.json`), JSON.stringify(entry(DEAD_PID)));

    await endLaunch(state.stateDir, {
      repoHash: REPO,
      launchId: newLaunchId(),
      onLast: async () => undefined,
    });

    expect(await files()).toEqual([`${live.launchId}.json`]);
  });

  it("does not count a live pid whose heartbeat is older than 90 s", async () => {
    const stale = entry();

    await register(stale);

    const old = new Date(Date.now() - 120_000);

    await utimes(join(stateLayout(state.stateDir).repo(REPO).launches, `${stale.launchId}.json`), old, old);

    expect(await liveLaunches(state.stateDir, REPO)).toEqual([]);
  });

  it("does not count a live pid recorded with another boot time", async () => {
    await register({ ...entry(), boot: bootTime() - 3600 });

    expect(await liveLaunches(state.stateDir, REPO)).toEqual([]);
  });

  it("lists launches of every repository", async () => {
    await register(entry());

    await register(entry(process.pid, "2".repeat(64)));

    expect(await liveLaunches(state.stateDir)).toHaveLength(2);
  });

  it("takes over a lock left by a dead launcher", async () => {
    const first = entry();

    await register(first);

    await writeFile(stateLayout(state.stateDir).repo(REPO).lock, `${DEAD_PID} ${bootTime()} x`);

    expect(await register(entry())).toBe(2);
  });

  it("takes over a lock without a readable pid at once", async () => {
    const first = entry();
    const lock = stateLayout(state.stateDir).repo(REPO).lock;

    await register(first);

    await writeFile(lock, "");

    expect(await register(entry())).toBe(2);
  });

  it("registers concurrent launches without losing any", async () => {
    const counts = await Promise.all([1, 2, 3, 4].map(() => register(entry())));

    expect([...counts].sort()).toEqual([1, 2, 3, 4]);
  });
});
