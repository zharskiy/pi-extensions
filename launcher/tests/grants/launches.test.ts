import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  endLaunch,
  launchState,
  liveLaunches,
  newLaunchId,
  othersLive,
  registerLaunch,
} from "../../grants/index.ts";
import { bootTime, processMark, stateLayout } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const REPO = "1".repeat(64);

const OTHER = "2".repeat(64);

const DEAD_PID = 999_999;

const state = { stateDir: "", self: { pid: 0, boot: 0, start: "" } };

beforeEach(async () => {
  state.stateDir = await tempDir("launches");

  state.self = await processMark();
});

const entry = (pid = process.pid, repoHash = REPO) => ({
  launchId: newLaunchId(),
  ...state.self,
  pid,
  repoHash,
  startedAt: 1,
});

const register = (launch: ReturnType<typeof entry>) => registerLaunch(state.stateDir, launch);

const liveIds = async () => (await liveLaunches(state.stateDir)).map((launch) => launch.launchId).sort();

describe("launches", () => {
  it("makes 16 hex launch ids", () => {
    expect(newLaunchId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newLaunchId()).not.toBe(newLaunchId());
  });

  it("keeps the launches of every repository in one registry and reports what remains when one ends", async () => {
    const first = entry();
    const second = entry();
    const other = entry(process.pid, OTHER);

    await register(first);

    await register(second);

    await register(other);

    const afterFirst = await endLaunch(state.stateDir, first.launchId);
    const afterSecond = await endLaunch(state.stateDir, second.launchId);

    expect(afterFirst.map((launch) => launch.launchId).sort()).toEqual(
      [second.launchId, other.launchId].sort(),
    );
    expect(afterSecond.map((launch) => launch.repoHash)).toEqual([OTHER]);
  });

  it("tells whether other launches of a repository live, apart from a given launch", async () => {
    const own = entry();

    await register(own);

    await register(entry(process.pid, OTHER));

    expect(await othersLive(state.stateDir, REPO, own.launchId)).toBe(false);
    expect(await othersLive(state.stateDir, REPO)).toBe(true);
    expect(await othersLive(state.stateDir, OTHER, own.launchId)).toBe(true);
  });

  it("ignores a launch whose launcher pid is dead and reports it as dead with its repository", async () => {
    const live = entry();
    const directory = stateLayout(state.stateDir).launches;
    const dead = entry(DEAD_PID, OTHER);

    await register(live);

    await writeFile(join(directory, `${dead.launchId}.json`), JSON.stringify(dead));

    const found = await launchState(state.stateDir);

    expect(await liveIds()).toEqual([live.launchId]);
    expect(found.dead.map((launch) => launch.repoHash)).toEqual([OTHER]);
  });

  it("deletes the entry of a dead launcher when another launch registers or ends", async () => {
    const directory = stateLayout(state.stateDir).launches;
    const live = entry();
    const files = async () => (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();

    await register(entry(DEAD_PID));

    expect(await files()).toEqual([]);

    await register(live);

    await writeFile(join(directory, `${"a".repeat(16)}.json`), JSON.stringify(entry(DEAD_PID)));

    await endLaunch(state.stateDir, newLaunchId());

    expect(await files()).toEqual([`${live.launchId}.json`]);
  });

  it("keeps counting a live launch whose entry was last touched hours ago, as after the Mac slept", async () => {
    const slept = entry();
    const directory = stateLayout(state.stateDir).launches;

    await register(slept);

    const old = new Date(Date.now() - 6 * 60 * 60 * 1000);

    await utimes(join(directory, `${slept.launchId}.json`), old, old);

    await register(entry());

    expect(await liveIds()).toHaveLength(2);
    expect(await liveIds()).toContain(slept.launchId);
    expect(await readdir(directory)).toContain(`${slept.launchId}.json`);
  });

  it("does not count a live pid recorded with another process start time, as after pid reuse", async () => {
    await register({ ...entry(), start: "Thu-Jan-1-00:00:00-1970" });

    expect(await liveLaunches(state.stateDir)).toEqual([]);
  });

  it("does not count a live pid recorded with another boot time", async () => {
    await register({ ...entry(), boot: bootTime() - 3600 });

    expect(await liveLaunches(state.stateDir)).toEqual([]);
  });

  it("takes over a lock left by a dead launcher", async () => {
    await register(entry());

    await writeFile(
      stateLayout(state.stateDir).launchesLock,
      `${DEAD_PID} ${bootTime()} ${state.self.start} x`,
    );

    await register(entry());

    expect(await liveIds()).toHaveLength(2);
  });

  it("takes over a lock without a readable pid at once", async () => {
    await register(entry());

    await writeFile(stateLayout(state.stateDir).launchesLock, "");

    await register(entry());

    expect(await liveIds()).toHaveLength(2);
  });

  it("registers concurrent launches without losing any", async () => {
    const launches = [1, 2, 3, 4].map(() => entry());

    await Promise.all(launches.map(register));

    expect(await liveIds()).toEqual(launches.map((launch) => launch.launchId).sort());
  });
});
