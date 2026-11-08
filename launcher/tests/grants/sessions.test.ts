import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endSession, liveSessions, newSessionId, registerSession } from "../../grants/index.ts";

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
  sessionId: newSessionId(),
  pid,
  repoHash,
  startedAt: 1,
});

describe("sessions", () => {
  it("makes 16 hex launch ids", () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newSessionId()).not.toBe(newSessionId());
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
        sessionId: first.sessionId,
        onLast: async () => void calls.push("first"),
      }),
    ).toBe(1);
    expect(
      await endSession(state.stateDir, {
        repoHash: REPO,
        sessionId: second.sessionId,
        onLast: async () => void calls.push("second"),
      }),
    ).toBe(0);
    expect(calls).toEqual(["second"]);
  });

  it("ignores a session whose launcher pid is dead", async () => {
    const live = entry();

    await registerSession(state.stateDir, entry(DEAD_PID));

    await registerSession(state.stateDir, live);

    expect((await liveSessions(state.stateDir, REPO)).map((session) => session.sessionId)).toEqual([
      live.sessionId,
    ]);
    expect(await liveSessions(state.stateDir, REPO, () => false)).toEqual([]);

    const calls: string[] = [];

    await endSession(state.stateDir, {
      repoHash: REPO,
      sessionId: live.sessionId,
      onLast: async () => void calls.push("last"),
    });

    expect(calls).toEqual(["last"]);
  });

  it("deletes the entry of a dead launcher when another session registers or ends", async () => {
    const directory = join(state.stateDir, "sessions", REPO);
    const live = entry();
    const files = async () => (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();

    await registerSession(state.stateDir, entry(DEAD_PID));

    expect(await files()).toEqual([]);

    await registerSession(state.stateDir, live);

    await writeFile(join(directory, `${"a".repeat(16)}.json`), JSON.stringify(entry(DEAD_PID)));

    await endSession(state.stateDir, {
      repoHash: REPO,
      sessionId: newSessionId(),
      onLast: async () => undefined,
    });

    expect(await files()).toEqual([`${live.sessionId}.json`]);
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

  it("treats a lock without a readable pid as held until it is 10 s old", async () => {
    const first = entry();
    const lock = join(state.stateDir, "sessions", REPO, "lock");

    await registerSession(state.stateDir, first);

    await writeFile(lock, "");

    const waiting = { done: false };
    const second = registerSession(state.stateDir, entry()).then((count) => {
      waiting.done = true;

      return count;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(waiting.done).toBe(false);

    const old = new Date(Date.now() - 11_000);

    await utimes(lock, old, old);

    expect(await second).toBe(2);
  });

  it("registers concurrent sessions without losing any", async () => {
    const counts = await Promise.all([1, 2, 3, 4].map(() => registerSession(state.stateDir, entry())));

    expect([...counts].sort()).toEqual([1, 2, 3, 4]);
  });
});
