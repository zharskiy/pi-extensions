import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PREPARE_WAITING, runSetup, withPrepareLock } from "../../cli/prepare.ts";
import { bootTime, stateLayout, withFileLock } from "../../shared/index.ts";
import { runningContainer } from "../provision/fixtures.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { tempDir } from "../support/temp-dir.ts";

const REPO = "0".repeat(64);

const deadPid = async () => {
  const child = spawn(process.execPath, ["-e", ""]);

  await new Promise((resolve) => child.once("exit", resolve));

  return child.pid ?? 0;
};

const lockOf = (stateDir: string) => stateLayout(stateDir).repo(REPO).prepareLock;

const prepared = async () => {
  const stateDir = await tempDir("prepare");
  const lines: string[] = [];
  const lock = {
    stateDir,
    repoHash: REPO,
    signal: new AbortController().signal,
    progress: (line: string) => lines.push(line),
  };

  return { stateDir, lines, lock };
};

const gate = () => {
  const opened: { resolve: () => void } = { resolve: () => undefined };
  const promise = new Promise<void>((resolve) => {
    opened.resolve = resolve;
  });

  return { promise, resolve: () => opened.resolve() };
};

describe("withPrepareLock", () => {
  it("runs at once and says nothing when no other session prepares the folder", async () => {
    const { lines, lock } = await prepared();

    expect(await withPrepareLock(lock, async () => "done")).toBe("done");
    expect(lines).toEqual([]);
  });

  it("says once that it waits while another session holds the lock, then runs after it", async () => {
    const { stateDir, lines, lock } = await prepared();
    const order: string[] = [];
    const release = gate();
    const holder = withFileLock(lockOf(stateDir), async () => {
      order.push("holder");

      await release.promise;
    });
    const waiter = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return withPrepareLock(lock, async () => {
        order.push("waiter");
      });
    })();

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(lines).toEqual([PREPARE_WAITING]);

    release.resolve();

    await Promise.all([holder, waiter]);

    expect(order).toEqual(["holder", "waiter"]);
    expect(lines).toEqual([PREPARE_WAITING]);
  });

  it("takes over the lock of a dead holder without waiting", async () => {
    const { stateDir, lines, lock } = await prepared();

    await mkdir(dirname(lockOf(stateDir)), { recursive: true });

    await writeFile(
      lockOf(stateDir),
      `${await deadPid()} ${bootTime()} Mon-Nov-9-00:00:00-2026 0123456789abcdef`,
    );

    expect(await withPrepareLock(lock, async () => "taken")).toBe("taken");
    expect(lines).toEqual([]);
  });

  it("stops waiting when the launch is cancelled", async () => {
    const { stateDir, lock } = await prepared();
    const cancel = new AbortController();
    const release = gate();
    const holder = withFileLock(lockOf(stateDir), () => release.promise);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const waiting = withPrepareLock({ ...lock, signal: cancel.signal }, async () => "ran");

    cancel.abort();

    await expect(waiting).rejects.toThrow();

    release.resolve();

    await holder;
  });
});

describe("runSetup", () => {
  const setupRun = (fake: ReturnType<typeof createFakeBackend>, commands: string[][]) => {
    const lines: string[] = [];
    const run = {
      backend: fake.backend,
      containerId: "",
      commands,
      env: { PI_SANDBOX_LAUNCH_ID: "0123456789abcdef" },
      workdir: "/work/repo",
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      signal: new AbortController().signal,
      progress: (line: string) => lines.push(line),
    };

    return { run, lines };
  };

  it("runs each command in order as pi does, with pi's env and the repository as cwd, without a tty or stdin", async () => {
    const fake = createFakeBackend({ exec: () => 0 });
    const { run, lines } = setupRun(fake, [
      ["npm", "ci"],
      ["sh", "-c", "make init"],
    ]);
    const containerId = await runningContainer(fake.backend);

    await runSetup({ ...run, containerId });

    expect(fake.execs.map((exec) => exec.spec)).toEqual([
      { containerId, command: ["npm", "ci"], env: run.env, workdir: "/work/repo" },
      { containerId, command: ["sh", "-c", "make init"], env: run.env, workdir: "/work/repo" },
    ]);
    expect(fake.execs.map((exec) => exec.tty)).toEqual([false, false]);
    expect(fake.execs.flatMap((exec) => exec.stdin)).toEqual([]);
    expect(lines).toEqual(["pi-sandbox: setup: npm ci", "pi-sandbox: setup: sh -c make init"]);
  });

  it("stops at the first command that fails, naming it and its exit code", async () => {
    const fake = createFakeBackend({ exec: (spec) => (spec.command[0] === "false" ? 3 : 0) });
    const { run } = setupRun(fake, [["false"], ["npm", "ci"]]);
    const containerId = await runningContainer(fake.backend);

    await expect(runSetup({ ...run, containerId })).rejects.toMatchObject({
      message: "setup: false exited with code 3, so pi did not start",
      hint: "fix or remove that command in setup",
    });
    expect(fake.execs).toHaveLength(1);
  });

  it("stops after the running command when the launch is cancelled", async () => {
    const cancel = new AbortController();
    const fake = createFakeBackend({
      exec: () => {
        cancel.abort();

        return 1;
      },
    });
    const { run } = setupRun(fake, [
      ["sleep", "60"],
      ["npm", "ci"],
    ]);
    const containerId = await runningContainer(fake.backend);

    await expect(runSetup({ ...run, containerId, signal: cancel.signal })).rejects.toThrow();
    expect(fake.execs).toHaveLength(1);
  });
});
