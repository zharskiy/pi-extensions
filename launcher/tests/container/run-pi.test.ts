import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ExecIo, ExecSpec, TerminalSize } from "../../backend/index.ts";
import { type HostTerminal, runPi } from "../../container/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";

const workspace = {
  cwd: "/work/repo/src",
  repoRoot: "/work/repo",
  gitCommonDir: "/work/repo/.git",
  isGitRepo: true,
};

const fakeTerminal = (isTTY: boolean, stdoutTTY = isTTY) => {
  const stdin = Object.assign(new PassThrough(), {
    isTTY,
    rawModes: [] as boolean[],
    setRawMode(mode: boolean) {
      stdin.rawModes.push(mode);

      return stdin;
    },
  });
  const listeners = new Set<(size: TerminalSize) => void>();
  const terminal: HostTerminal = {
    stdin,
    stdout: Object.assign(new PassThrough(), { isTTY: stdoutTTY }),
    stderr: new PassThrough(),
    columns: 120,
    rows: 40,
    onResize: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
  const resize = (size: TerminalSize) =>
    listeners.forEach((listener) => {
      listener(size);
    });

  return { terminal, stdin, listeners, resize };
};

const PI_WRAPPER =
  /^echo \$\$ > (\/tmp\/pi-sandbox-pi\.pid); cd "\$1" 2>\/dev\/null \|\| echo "pi-sandbox: \$1 is not in the sandbox, pi starts in \$PWD" >&2; shift; exec "\$@"$/;

let launches = 0;

const nextLaunchId = () => {
  launches += 1;

  return launches.toString(16).padStart(16, "0");
};

const pidFileOf = (command: string[]) => PI_WRAPPER.exec(command[2] ?? "")?.[1];

const isPiExec = (spec: ExecSpec) => pidFileOf(spec.command) !== undefined;

const scripts = (execs: Array<{ spec: ExecSpec }>) =>
  execs.filter((exec) => !isPiExec(exec.spec)).map((exec) => exec.spec.command);

const pending = () => {
  const control: { finish: (code: number) => void } = { finish: () => undefined };
  const done = new Promise<number>((resolve) => {
    control.finish = resolve;
  });

  return { done, finish: (code: number) => control.finish(code) };
};

describe("runPi", () => {
  it("execs pi in the host cwd behind a pid file wrapper and returns its exit code", async () => {
    const fake = createFakeBackend({ exec: () => 3 });
    const { terminal } = fakeTerminal(true);
    const exitCode = await runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "container-9",
      piArgs: ["--model", "x"],
      workspace,
      terminal,
    });

    const command = fake.execs[0]?.spec.command ?? [];
    const pidFile = pidFileOf(command);

    expect(exitCode).toBe(3);
    expect(fake.execs[0]?.spec).toEqual({
      containerId: "container-9",
      command: ["sh", "-c", expect.stringMatching(PI_WRAPPER), "sh", "/work/repo/src", "pi", "--model", "x"],
      env: { PI_SANDBOX_LAUNCH_ID: expect.stringMatching(/^[0-9a-f]{16}$/) },
      workdir: "/work/repo",
    });
    expect(fake.execs[0]?.tty).toBe(true);
    expect(fake.execs[0]?.size).toEqual({ columns: 120, rows: 40 });
    expect(pidFile).toBe("/tmp/pi-sandbox-pi.pid");
    expect(scripts(fake.execs)).toEqual([]);
    expect(fake.stops).toEqual([]);
  });

  it("passes the exec env through and adds the launch id to it only", async () => {
    const fake = createFakeBackend({ exec: () => 0 });
    const { terminal } = fakeTerminal(false);

    await runPi({
      backend: fake.backend,
      containerId: "container-9",
      piArgs: [],
      env: { TERM: "xterm-256color", PI_SANDBOX_DEBUG: "1" },
      launchId: "0123456789abcdef",
      workspace,
      terminal,
    });

    expect(fake.execs[0]?.spec.env).toEqual({
      TERM: "xterm-256color",
      PI_SANDBOX_DEBUG: "1",
      PI_SANDBOX_LAUNCH_ID: "0123456789abcdef",
    });
  });

  it("hands pi's stderr stream to the exec separately from stdout", async () => {
    const seen: ExecIo[] = [];
    const fake = createFakeBackend({
      exec: (_spec, io) => {
        seen.push(io);

        return 0;
      },
    });
    const { terminal } = fakeTerminal(false);

    await runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal,
    });

    expect(seen[0]?.stdout).toBe(terminal.stdout);
    expect(seen[0]?.stderr).toBe(terminal.stderr);
  });

  it("forwards resize events while pi runs", async () => {
    const host = fakeTerminal(true);
    const fake = createFakeBackend({
      exec: () => {
        host.resize({ columns: 80, rows: 24 });
        host.resize({ columns: 200, rows: 50 });

        return 0;
      },
    });

    await runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal: host.terminal,
    });

    expect(fake.execs[0]?.resizes).toEqual([
      { columns: 80, rows: 24 },
      { columns: 200, rows: 50 },
    ]);
    expect(host.listeners.size).toBe(0);
  });

  it("sets raw mode on a tty and restores it even when exec fails", async () => {
    const host = fakeTerminal(true);
    const fake = createFakeBackend({
      exec: () => {
        throw new Error("exec failed");
      },
    });

    await expect(
      runPi({
        launchId: nextLaunchId(),
        backend: fake.backend,
        containerId: "c",
        piArgs: [],
        workspace,
        terminal: host.terminal,
      }),
    ).rejects.toThrow("exec failed");
    expect(host.stdin.rawModes).toEqual([true, false]);
  });

  it("execs without a tty or raw mode when stdout is not a terminal, even with a tty stdin", async () => {
    const host = fakeTerminal(true, false);
    const fake = createFakeBackend();

    await runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: ["-p", "hi"],
      workspace,
      terminal: host.terminal,
    });

    expect(host.stdin.rawModes).toEqual([]);
    expect(fake.execs[0]?.tty).toBe(false);
  });

  it("starts pi in the repository root with a notice when the cwd is hidden in the sandbox", async () => {
    const fake = createFakeBackend();
    const { terminal } = fakeTerminal(false);
    const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-sandbox-run-pi-")));
    const elsewhere = realpathSync(tmpdir());

    await runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal,
    });

    const command = fake.execs[0]?.spec.command ?? [];
    const script = (command[2] ?? "").replace(pidFileOf(command) ?? "", join(root, "pid"));
    const shell = (cwd: string) =>
      spawnSync("sh", ["-c", script, "sh", cwd, "pwd"], { cwd: root, encoding: "utf8" });
    const hidden = shell(join(root, "node_modules", "pkg"));
    const present = shell(elsewhere);

    await rm(root, { recursive: true, force: true });

    expect(hidden.stdout.trim()).toBe(root);
    expect(hidden.stderr).toBe(
      `pi-sandbox: ${join(root, "node_modules", "pkg")} is not in the sandbox, pi starts in ${root}\n`,
    );
    expect(present.stdout.trim()).toBe(elsewhere);
    expect(present.stderr).toBe("");
  });

  it("leaves a non-tty stdin alone and execs without a tty", async () => {
    const host = fakeTerminal(false);
    const fake = createFakeBackend();

    await runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: ["-p", "hi"],
      workspace,
      terminal: host.terminal,
    });

    expect(host.stdin.rawModes).toEqual([]);
    expect(fake.execs[0]?.tty).toBe(false);
  });
});

describe("runPi on a signal", () => {
  const signalled = (isTTY: boolean, codeOnKill?: number) => {
    const signals = new EventEmitter();
    const host = fakeTerminal(isTTY);
    const pi = pending();
    const fake = createFakeBackend({
      exec: (spec: ExecSpec) => {
        if (isPiExec(spec)) {
          signals.emit("ready");

          return pi.done;
        }

        if (codeOnKill !== undefined && spec.command[2]?.startsWith("kill") === true) {
          pi.finish(codeOnKill);
        }

        return 0;
      },
    });

    const started = new Promise((resolve) => signals.once("ready", resolve));

    return { signals, host, pi, fake, started };
  };

  it("signals only pi on SIGTERM and keeps the container when pi exits in time", async () => {
    const { signals, host, fake, started } = signalled(true, 143);
    const running = runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal: host.terminal,
      signals,
    });

    await started;

    signals.emit("SIGTERM");

    expect(await running).toBe(143);

    const pidFile = pidFileOf(fake.execs[0]?.spec.command ?? []);

    expect(pidFile).toBeDefined();
    expect(scripts(fake.execs)).toEqual([["sh", "-c", `kill -TERM "$(cat ${pidFile})"`]]);
    expect(host.stdin.rawModes).toEqual([true, false]);
    expect(fake.stops).toEqual([]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops the launch's own container when pi ignores SIGHUP for the grace period", async () => {
    const { signals, host, fake, started } = signalled(false);
    const running = runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal: host.terminal,
      signals,
      graceMs: 10,
    });

    await started;

    signals.emit("SIGHUP");

    expect(await running).toBe(129);

    const pidFile = pidFileOf(fake.execs[0]?.spec.command ?? []);

    expect(fake.stops).toEqual([{ id: "c", timeoutSeconds: 0 }]);
    expect(scripts(fake.execs)).toEqual([["sh", "-c", `kill -TERM "$(cat ${pidFile})"`]]);
  });

  it("ends pi on SIGINT with or without a tty, and returns pi's own code when it exits in time", async () => {
    const tty = signalled(true, 0);
    const pipe = signalled(false, 130);
    const run = (side: typeof tty) =>
      runPi({
        launchId: nextLaunchId(),
        backend: side.fake.backend,
        containerId: "c",
        piArgs: [],
        workspace,
        terminal: side.host.terminal,
        signals: side.signals,
      });
    const ttyRun = run(tty);
    const pipeRun = run(pipe);

    await Promise.all([tty.started, pipe.started]);

    tty.signals.emit("SIGINT");
    pipe.signals.emit("SIGINT");

    expect(await ttyRun).toBe(0);
    expect(await pipeRun).toBe(130);
    expect(tty.host.stdin.rawModes).toEqual([true, false]);
    expect(tty.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("returns when the engine never answers the kill, instead of waiting for it", async () => {
    const signals = new EventEmitter();
    const host = fakeTerminal(false);
    const fake = createFakeBackend({
      exec: (spec: ExecSpec) => {
        if (isPiExec(spec)) {
          signals.emit("ready");
        }

        return new Promise<number>(() => undefined);
      },
    });
    const started = new Promise((resolve) => signals.once("ready", resolve));
    const running = runPi({
      launchId: nextLaunchId(),
      backend: fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal: host.terminal,
      signals,
      graceMs: 5,
    });

    await started;

    signals.emit("SIGTERM");

    expect(await running).toBe(143);
  });
});
