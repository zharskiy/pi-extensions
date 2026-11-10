import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignIn } from "../../proxy/sign-in.ts";
import { mcpAuthKey, readMcpLogins, stateLayout, withFileLock } from "../../shared/index.ts";

const IGNORES_TERM = "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);";

const state = { dir: "", children: [] as ChildProcess[] };

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-sign-in-"));
});

afterEach(async () => {
  state.children.splice(0).forEach((child) => {
    child.kill("SIGKILL");
  });

  await rm(state.dir, { recursive: true, force: true });
});

const isRunning = (pid: number | undefined) => {
  try {
    process.kill(pid ?? 0, 0);

    return true;
  } catch {
    return false;
  }
};

const stubborn = (_file: string, _args: string[], options: SpawnOptions) => {
  const child = spawn(process.execPath, ["-e", IGNORES_TERM], { ...options, stdio: "ignore" });

  state.children.push(child);

  return child;
};

const signInWith = (spawnLogin: typeof stubborn) =>
  createSignIn({
    stateDir: state.dir,
    hostAgentDir: join(state.dir, "agent"),
    piCommand: ["pi"],
    env: {},
    now: Date.now,
    spawn: spawnLogin,
  });

describe("sign-in shutdown", () => {
  it("records no start and spawns nothing when the proxy closes while the start waits for the record", async () => {
    const spawned: string[] = [];
    const signIn = signInWith((file, args, options) => {
      spawned.push(file);

      return stubborn(file, args, options);
    });
    const release: { now: () => void } = { now: () => undefined };
    const held = withFileLock(
      stateLayout(state.dir).mcpLoginFileLock,
      () => new Promise<void>((resolve) => (release.now = resolve)),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = signIn.start("docs", "https://docs.test/mcp");

    await new Promise((resolve) => setTimeout(resolve, 100));

    const closed = signIn.close();

    release.now();

    await held;

    expect(await started).toBeUndefined();

    await closed;

    expect(spawned).toEqual([]);
    expect(
      (await readMcpLogins(state.dir))[mcpAuthKey("docs", "https://docs.test/mcp")]?.lastStart,
    ).toBeUndefined();
  });

  it("kills a login that starts while the proxy is closing, even when it ignores SIGTERM", async () => {
    const holder: { signIn?: ReturnType<typeof signInWith>; closed?: Promise<void> } = {};
    const signIn = signInWith((file, args, options) => {
      if (holder.closed === undefined && String(args.at(-3)) === "late") {
        holder.closed = holder.signIn?.close();
      }

      return stubborn(file, args, options);
    });

    holder.signIn = signIn;

    const first = await signIn.start("early", "https://early.test/mcp");

    expect(first).toBeDefined();

    await signIn.start("late", "https://late.test/mcp");

    await holder.closed;

    const pids = state.children.map((child) => child.pid);

    expect(pids).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(pids.map(isRunning)).toEqual([false, false]);
  }, 20_000);
});
