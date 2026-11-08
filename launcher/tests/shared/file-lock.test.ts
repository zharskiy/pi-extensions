import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorMessage, withDirectoryLock, withFileLock } from "../../shared/index.ts";

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

const lockError = (attempt: Promise<unknown>) =>
  attempt.then(
    () => undefined,
    (error: unknown) => errorMessage(error),
  );

const deadPid = async () => {
  const child = spawn(process.execPath, ["-e", ""]);

  await new Promise((resolve) => child.once("exit", resolve));

  return child.pid ?? 0;
};

const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);

const longAgo = () => new Date(Date.now() - 60_000);

const SHARED = pathToFileURL(join(import.meta.dirname, "..", "..", "shared", "index.ts")).href;

const contender = (kind: string, lock: string, log: string) =>
  promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    [
      `import { appendFile } from "node:fs/promises";`,
      `import { ${kind} } from ${JSON.stringify(SHARED)};`,
      "const [lock, log] = process.argv.slice(1);",
      "const pause = () => new Promise((resolve) => setTimeout(resolve, 15));",
      "const turn = () => " +
        `${kind}(lock, async () => { await appendFile(log, "in\\n"); await pause(); await appendFile(log, "out\\n"); }, { timeoutMs: 20000 });`,
      "await turn(); await turn(); await turn();",
    ].join("\n"),
    lock,
    log,
  ]);

const expectNoOverlap = async (log: string, turns: number) => {
  const lines = (await readFile(log, "utf8")).trim().split("\n");

  expect(lines).toEqual(Array.from({ length: turns }, () => ["in", "out"]).flat());
};

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

  it("never takes over the lock of a live holder, however long it has been stalled", async () => {
    const lockPath = join(state.dir, "store.json.lock");
    const holder = sleeper();

    try {
      await writeFile(lockPath, String(holder.pid));

      await utimes(lockPath, longAgo(), longAgo());

      const problem = await lockError(withFileLock(lockPath, async () => "never", { timeoutMs: 150 }));

      expect(problem).toBe(`${lockPath}: lock is held by another process (pid ${holder.pid})`);
      expect(await readFile(lockPath, "utf8")).toBe(String(holder.pid));
    } finally {
      holder.kill();
    }
  });

  it("takes over the lock of a dead holder at once and leaves nothing behind", async () => {
    const lockPath = join(state.dir, "store.json.lock");

    await writeFile(lockPath, String(await deadPid()));

    expect(await withFileLock(lockPath, async () => "taken", { timeoutMs: 100 })).toBe("taken");
    expect(await readdir(state.dir)).toEqual([]);
  });

  it("takes over a lock without a readable owner at once", async () => {
    const lockPath = join(state.dir, "store.json.lock");

    await writeFile(lockPath, "");

    expect(await withFileLock(lockPath, async () => "taken", { timeoutMs: 100 })).toBe("taken");
    expect(await readdir(state.dir)).toEqual([]);
  });

  it("does not remove a newer holder's lock when its own lock was taken from it", async () => {
    const lockPath = join(state.dir, "store.json.lock");
    const holder = sleeper();

    try {
      await withFileLock(lockPath, async () => {
        await rm(lockPath);

        await writeFile(lockPath, String(holder.pid));
      });

      expect(await readFile(lockPath, "utf8")).toBe(String(holder.pid));
    } finally {
      holder.kill();
    }
  });

  it("lets processes racing for a lock left by a dead holder in one at a time", async () => {
    const lockPath = join(state.dir, "store.json.lock");
    const log = join(state.dir, "log");

    await writeFile(lockPath, String(await deadPid()));

    await Promise.all(Array.from({ length: 4 }, () => contender("withFileLock", lockPath, log)));

    await expectNoOverlap(log, 12);

    expect(await exists(lockPath)).toBe(false);
  }, 30_000);
});

describe("withDirectoryLock", () => {
  it("holds an empty directory, the lock format pi uses for the same file", async () => {
    const lockPath = join(state.dir, "mcp-auth.json.lock");

    const inside = await withDirectoryLock(lockPath, async () => ({
      directory: (await stat(lockPath)).isDirectory(),
      entries: await readdir(lockPath),
    }));

    expect(inside).toEqual({ directory: true, entries: [] });
    expect(await exists(lockPath)).toBe(false);
  });

  it("waits for a directory lock that its holder keeps fresh", async () => {
    const lockPath = join(state.dir, "mcp-auth.json.lock");

    await mkdir(lockPath);

    const problem = await lockError(withDirectoryLock(lockPath, async () => "never", { timeoutMs: 100 }));

    expect(problem).toBe(`${lockPath}: lock is held by another process`);
    expect(await exists(lockPath)).toBe(true);
  });

  it("takes over a directory lock that stopped being refreshed", async () => {
    const lockPath = join(state.dir, "mcp-auth.json.lock");

    await mkdir(lockPath);

    await utimes(lockPath, longAgo(), longAgo());

    expect(await withDirectoryLock(lockPath, async () => "taken", { timeoutMs: 200 })).toBe("taken");
    expect(await readdir(state.dir)).toEqual([]);
  });

  it("keeps a long holder's lock fresh so a short stale window does not let others in", async () => {
    const lockPath = join(state.dir, "mcp-auth.json.lock");
    const events: string[] = [];
    const long = withDirectoryLock(
      lockPath,
      async () => {
        events.push("long in");

        await sleep(250);

        events.push("long out");
      },
      { staleMs: 100 },
    );

    await sleep(20);

    const short = withDirectoryLock(
      lockPath,
      async () => {
        events.push("short");
      },
      { staleMs: 100, timeoutMs: 2_000, retryMs: 10 },
    );

    await Promise.all([long, short]);

    expect(events).toEqual(["long in", "long out", "short"]);
  });

  it("lets processes racing for an abandoned directory lock in one at a time", async () => {
    const lockPath = join(state.dir, "mcp-auth.json.lock");
    const log = join(state.dir, "log");

    await mkdir(lockPath);

    await utimes(lockPath, longAgo(), longAgo());

    await Promise.all(Array.from({ length: 4 }, () => contender("withDirectoryLock", lockPath, log)));

    await expectNoOverlap(log, 12);
  }, 30_000);
});
