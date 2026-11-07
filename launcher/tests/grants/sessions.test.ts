import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endSession, liveSessions, newLaunchId, registerSession } from "../../grants/index.ts";

const REPO = "1".repeat(64);

const DEAD_PID = 999_999;

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-sessions-"));
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

describe("sessions", () => {
  it("makes 16 hex launch ids", () => {
    expect(newLaunchId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newLaunchId()).not.toBe(newLaunchId());
  });

  it("counts live sessions per repository and runs onLast only for the last one", async () => {
    const first = entry();
    const second = entry();
    const calls: string[] = [];

    expect(await registerSession(state.stateDir, first)).toBe(1);
    expect(await registerSession(state.stateDir, second)).toBe(2);
    expect(await registerSession(state.stateDir, entry(process.pid, "2".repeat(64)))).toBe(1);

    expect(
      await endSession(state.stateDir, {
        repoHash: REPO,
        launchId: first.launchId,
        onLast: async () => void calls.push("first"),
      }),
    ).toBe(1);
    expect(
      await endSession(state.stateDir, {
        repoHash: REPO,
        launchId: second.launchId,
        onLast: async () => void calls.push("second"),
      }),
    ).toBe(0);
    expect(calls).toEqual(["second"]);
  });

  it("ignores a session whose launcher pid is dead", async () => {
    const live = entry();

    await registerSession(state.stateDir, entry(DEAD_PID));

    await registerSession(state.stateDir, live);

    expect((await liveSessions(state.stateDir, REPO)).map((session) => session.launchId)).toEqual([
      live.launchId,
    ]);
    expect(await liveSessions(state.stateDir, REPO, () => false)).toEqual([]);

    const calls: string[] = [];

    await endSession(state.stateDir, {
      repoHash: REPO,
      launchId: live.launchId,
      onLast: async () => void calls.push("last"),
    });

    expect(calls).toEqual(["last"]);
  });

  it("lists sessions of every repository", async () => {
    await registerSession(state.stateDir, entry());

    await registerSession(state.stateDir, entry(process.pid, "2".repeat(64)));

    expect(await liveSessions(state.stateDir)).toHaveLength(2);
  });

  it("takes over a lock left by a dead launcher", async () => {
    const first = entry();

    await registerSession(state.stateDir, first);

    await writeFile(join(state.stateDir, "sessions", REPO, "lock"), String(DEAD_PID));

    expect(await registerSession(state.stateDir, entry())).toBe(2);
  });

  it("registers concurrent sessions without losing any", async () => {
    const counts = await Promise.all([1, 2, 3, 4].map(() => registerSession(state.stateDir, entry())));

    expect([...counts].sort()).toEqual([1, 2, 3, 4]);
  });
});
