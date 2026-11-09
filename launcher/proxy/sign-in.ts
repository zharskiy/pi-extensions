import {
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
  spawn as spawnProcess,
} from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  bootTime,
  type McpLoginState,
  makeMcpLoginDir,
  mcpAuthKey,
  mcpLoginCommand,
  PI_AGENT_DIR_VARIABLE,
  readMcpLogins,
  stateLayout,
  updateMcpLogin,
  withFileLockIfFree,
} from "../shared/index.ts";

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SignInDeps {
  stateDir: string;
  hostAgentDir: string;
  piCommand: string[];
  env: Record<string, string>;
  now: () => number;
  logFile?: string;
  spawn?: SpawnProcess;
}

interface Login {
  exited: Promise<number>;
}

export interface SignIn {
  start(server: string, url: string, rejected?: boolean): Promise<Login | undefined>;
  close(): Promise<void>;
}

const START_COOLDOWN_MS = 60_000;

const FAILURE_COOLDOWN_MS = 10 * 60_000;

const REJECTED_COOLDOWN_MS = 10 * 60_000;

const LOGIN_TIMEOUT_SECONDS = 300;

const since = (at: number | undefined, now: number, cooldownMs: number) =>
  at === undefined || now - at >= cooldownMs;

const mayStart = (state: McpLoginState, now: number, rejected: boolean) =>
  since(state.lastStart, now, START_COOLDOWN_MS) &&
  since(state.failedAt, now, FAILURE_COOLDOWN_MS) &&
  (!rejected || since(state.rejectedStart, now, REJECTED_COOLDOWN_MS));

const exitOf = (child: ChildProcess) =>
  new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });

const logStdio = (logFile: string | undefined) => {
  const fd = logFile === undefined ? undefined : openSync(logFile, "a", 0o600);

  return {
    stdio: (fd === undefined ? "ignore" : ["ignore", fd, fd]) as StdioOptions,
    release: () => {
      if (fd !== undefined) {
        closeSync(fd);
      }
    },
  };
};

const CLOSE_WAIT_MS = 2_000;

const signalGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
};

interface Running {
  pid?: number;
  done: Promise<number>;
}

export const createSignIn = (deps: SignInDeps): SignIn => {
  const running = new Map<string, Running>();
  const spawn = deps.spawn ?? spawnProcess;
  const closing = { now: false };

  const launch = async (server: string) => {
    const [file = "", ...args] = mcpLoginCommand(deps.piCommand, server, LOGIN_TIMEOUT_SECONDS);
    const cwd = await makeMcpLoginDir(deps.stateDir);
    const output = logStdio(deps.logFile);
    const child = spawn(file, args, {
      cwd,
      env: { ...deps.env, [PI_AGENT_DIR_VARIABLE]: deps.hostAgentDir },
      stdio: output.stdio,
      detached: true,
    });

    output.release();

    const exited = exitOf(child).then(async (code) => {
      await rm(cwd, { recursive: true, force: true });

      return code;
    });

    return { child, exited };
  };

  const runLogin = async (
    server: string,
    key: string,
    rejected: boolean,
    started: (child: ChildProcess) => void,
  ) => {
    const state = (await readMcpLogins(deps.stateDir))[key] ?? {};
    const now = deps.now();

    if (closing.now || !mayStart(state, now, rejected)) {
      return undefined;
    }

    await updateMcpLogin(deps.stateDir, key, (current) => ({
      ...current,
      lastStart: now,
      ...(rejected ? { rejectedStart: now } : {}),
    }));

    const login = await launch(server);
    const pgid = login.child.pid;

    if (pgid !== undefined) {
      await updateMcpLogin(deps.stateDir, key, (current) => ({
        ...current,
        running: { pgid, boot: bootTime() },
      }));
    }

    started(login.child);

    const code = await login.exited;

    await updateMcpLogin(deps.stateDir, key, ({ running: _ended, ...rest }) =>
      code === 0 || closing.now ? rest : { ...rest, failedAt: deps.now() },
    );

    return code;
  };

  const start = (server: string, url: string, rejected = false): Promise<Login | undefined> => {
    const key = mcpAuthKey(server, url);
    const known = running.get(key);

    if (known !== undefined) {
      return Promise.resolve({ exited: known.done });
    }

    if (deps.piCommand[0] === undefined) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const track = (child: ChildProcess) => {
        const entry: Running = {
          pid: child.pid,
          done: held.then(
            (outcome) => (outcome.busy ? 1 : (outcome.value ?? 1)),
            () => 1,
          ),
        };

        running.set(key, entry);

        void entry.done.then(() => running.delete(key));

        resolve({ exited: entry.done });
      };
      const held = withFileLockIfFree(stateLayout(deps.stateDir).mcpLoginLock(key), () =>
        runLogin(server, key, rejected, track),
      );

      void held.then(
        () => resolve(undefined),
        () => resolve(undefined),
      );
    });
  };

  const close = async () => {
    closing.now = true;

    const logins = [...running.values()];

    logins.forEach((login) => {
      signalGroup(login.pid, "SIGTERM");
    });

    const abort = new AbortController();
    const settled = Promise.all(logins.map((login) => login.done)).then(() => false);
    const timeout = delay(CLOSE_WAIT_MS, true, { signal: abort.signal }).catch(() => false);
    const late = await Promise.race([settled, timeout]);

    abort.abort();

    if (late) {
      logins.forEach((login) => {
        signalGroup(login.pid, "SIGKILL");
      });
    }
  };

  return { start, close };
};
