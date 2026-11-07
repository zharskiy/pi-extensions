import { EventEmitter } from "node:events";
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

const fakeTerminal = (isTTY: boolean) => {
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
    stdout: new PassThrough(),
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

const PI_WRAPPER = /^echo \$\$ > (\/tmp\/pi-sandbox-[0-9a-f]{16}\.pid); exec "\$@"$/;

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
      command: ["sh", "-c", expect.stringMatching(PI_WRAPPER), "sh", "pi", "--model", "x"],
      env: {},
      workdir: "/work/repo/src",
    });
    expect(fake.execs[0]?.tty).toBe(true);
    expect(fake.execs[0]?.size).toEqual({ columns: 120, rows: 40 });
    expect(scripts(fake.execs)).toEqual([["sh", "-c", `rm -f ${pidFile}`]]);
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

  it("gives every launch its own pid file", async () => {
    const fake = createFakeBackend();
    const { terminal } = fakeTerminal(false);

    await runPi({ backend: fake.backend, containerId: "c", piArgs: [], workspace, terminal });

    await runPi({ backend: fake.backend, containerId: "c", piArgs: [], workspace, terminal });

    const pidFiles = fake.execs
      .filter((exec) => isPiExec(exec.spec))
      .map((exec) => pidFileOf(exec.spec.command));

    expect(new Set(pidFiles).size).toBe(2);
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

    await runPi({ backend: fake.backend, containerId: "c", piArgs: [], workspace, terminal });

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

    await runPi({ backend: fake.backend, containerId: "c", piArgs: [], workspace, terminal: host.terminal });

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
      runPi({ backend: fake.backend, containerId: "c", piArgs: [], workspace, terminal: host.terminal }),
    ).rejects.toThrow("exec failed");
    expect(host.stdin.rawModes).toEqual([true, false]);
  });

  it("leaves a non-tty stdin alone and execs without a tty", async () => {
    const host = fakeTerminal(false);
    const fake = createFakeBackend();

    await runPi({
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
  const signalled = (isTTY: boolean, stopsOnKill: boolean) => {
    const signals = new EventEmitter();
    const host = fakeTerminal(isTTY);
    const pi = pending();
    const fake = createFakeBackend({
      exec: (spec: ExecSpec) => {
        if (isPiExec(spec)) {
          signals.emit("ready");

          return pi.done;
        }

        if (stopsOnKill && spec.command[2]?.startsWith("kill") === true) {
          pi.finish(143);
        }

        return 0;
      },
    });

    const started = new Promise((resolve) => signals.once("ready", resolve));

    return { signals, host, pi, fake, started };
  };

  it("signals only the pid in the launch's pid file on SIGTERM and leaves the container running", async () => {
    const { signals, host, fake, started } = signalled(true, true);
    const running = runPi({
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
    expect(scripts(fake.execs)).toEqual([
      ["sh", "-c", `kill -TERM "$(cat ${pidFile})"`],
      ["sh", "-c", `rm -f ${pidFile}`],
    ]);
    expect(host.stdin.rawModes).toEqual([true, false]);
    expect(fake.stops).toEqual([]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("kills only the launch's pi, never the shared container, when pi ignores SIGHUP for the grace period", async () => {
    const { signals, host, fake, started } = signalled(false, false);
    const running = runPi({
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

    expect(fake.stops).toEqual([]);
    expect(scripts(fake.execs)).toEqual([
      ["sh", "-c", `kill -TERM "$(cat ${pidFile})"`],
      ["sh", "-c", `kill -KILL "$(cat ${pidFile})"`],
      ["sh", "-c", `rm -f ${pidFile}`],
    ]);
  });

  it("handles SIGINT only without a tty, where it cannot reach pi as a keystroke", async () => {
    const tty = signalled(true, true);
    const pipe = signalled(false, true);
    const ttyRun = runPi({
      backend: tty.fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal: tty.host.terminal,
      signals: tty.signals,
    });
    const pipeRun = runPi({
      backend: pipe.fake.backend,
      containerId: "c",
      piArgs: [],
      workspace,
      terminal: pipe.host.terminal,
      signals: pipe.signals,
    });

    await Promise.all([tty.started, pipe.started]);

    expect(tty.signals.listenerCount("SIGINT")).toBe(0);

    pipe.signals.emit("SIGINT");

    expect(await pipeRun).toBe(130);

    tty.pi.finish(0);

    expect(await ttyRun).toBe(0);
  });
});
