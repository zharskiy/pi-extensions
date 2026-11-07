import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorMessage, withFileLock } from "../../shared/index.ts";

const state = { dir: "" };

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-lock-"));
});

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true });
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("withFileLock", () => {
  it("runs one holder at a time and removes the lock afterwards", async () => {
    const lockPath = join(state.dir, "nested", "store.json.lock");
    const events: string[] = [];
    const holder = (name: string) =>
      withFileLock(
        lockPath,
        async () => {
          events.push(`${name} in`);

          await sleep(30);

          events.push(`${name} out`);

          return name;
        },
        { retryMs: 5 },
      );

    const results = await Promise.all([holder("a"), holder("b"), holder("c")]);

    expect(results).toEqual(["a", "b", "c"]);

    expect(events.filter((_, index) => index % 2 === 0).map((event) => event.split(" ")[0])).toEqual(
      events.filter((_, index) => index % 2 === 1).map((event) => event.split(" ")[0]),
    );

    expect(await exists(lockPath)).toBe(false);
  });

  it("releases the lock when the holder throws", async () => {
    const lockPath = join(state.dir, "store.json.lock");

    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await exists(lockPath)).toBe(false);
  });

  it("takes over a lock whose holder stopped refreshing it", async () => {
    const lockPath = join(state.dir, "store.json.lock");
    const old = new Date(Date.now() - 60_000);

    await mkdir(lockPath);

    await utimes(lockPath, old, old);

    expect(await withFileLock(lockPath, async () => "taken", { staleMs: 1_000, timeoutMs: 200 })).toBe(
      "taken",
    );
  });

  it("gives up with a clear error when a fresh lock stays held", async () => {
    const lockPath = join(state.dir, "store.json.lock");

    await mkdir(lockPath);

    const problem = await withFileLock(lockPath, async () => "never", { timeoutMs: 100, retryMs: 10 }).then(
      () => undefined,
      (error: unknown) => errorMessage(error),
    );

    expect(problem).toBe(`${lockPath}: lock is held by another process`);

    expect(await exists(lockPath)).toBe(true);
  });

  it("keeps a long holder's lock fresh so others do not take it over", async () => {
    const lockPath = join(state.dir, "store.json.lock");
    const events: string[] = [];
    const long = withFileLock(
      lockPath,
      async () => {
        events.push("long in");

        await sleep(250);

        events.push("long out");
      },
      { staleMs: 100 },
    );

    await sleep(20);

    const short = withFileLock(
      lockPath,
      async () => {
        events.push("short");
      },
      { staleMs: 100, timeoutMs: 2_000, retryMs: 10 },
    );

    await Promise.all([long, short]);

    expect(events).toEqual(["long in", "long out", "short"]);
  });
});
