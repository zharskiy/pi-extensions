import type { Backend } from "../backend/index.ts";
import { othersLive } from "../grants/index.ts";
import {
  LauncherError,
  printable,
  stateLayout,
  withFileLockIfFree,
  withFileLockUnless,
  withWaitingLock,
} from "../shared/index.ts";
import { cleanupWaiting } from "./ground.ts";

export const PREPARE_WAITING = "pinata: waiting for another pi session of this folder to finish preparing";

const AGENT_WAITING = "pinata: waiting for another pi session to finish with the shared pi folder";

interface AgentLock {
  stateDir: string;
  signal?: AbortSignal;
  progress: (line: string) => void;
}

interface PrepareLock extends AgentLock {
  repoHash: string;
}

interface SetupRun {
  backend: Backend;
  containerId: string;
  commands: string[][];
  env: Record<string, string>;
  workdir: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  signal: AbortSignal;
  progress: (line: string) => void;
}

const prepareLockOf = (stateDir: string, repoHash: string) =>
  stateLayout(stateDir).repo(repoHash).prepareLock;

export const withPrepareLock = <T>(lock: PrepareLock, action: () => Promise<T>) =>
  withWaitingLock(prepareLockOf(lock.stateDir, lock.repoHash), action, {
    signal: lock.signal,
    onWait: () => lock.progress(PREPARE_WAITING),
  });

export const withAgentLock = <T>(lock: AgentLock, action: () => Promise<T>) =>
  withWaitingLock(stateLayout(lock.stateDir).agentLock, action, {
    signal: lock.signal,
    onWait: () => lock.progress(AGENT_WAITING),
  });

export const whenNotPreparing = <T>(stateDir: string, repoHash: string, action: () => Promise<T>) =>
  withFileLockIfFree(prepareLockOf(stateDir, repoHash), action);

export const whenLastOfRepo = <T>(lock: PrepareLock, action: () => Promise<T>) =>
  withFileLockUnless(prepareLockOf(lock.stateDir, lock.repoHash), action, {
    skip: () => othersLive(lock.stateDir, lock.repoHash),
    signal: lock.signal,
    onWait: () => lock.progress(cleanupWaiting(lock.signal)),
  });

const shown = (command: string[]) => printable(command.join(" "));

const runCommand = async (run: SetupRun, command: string[]) => {
  run.progress(`pinata: setup: ${shown(command)}`);

  const code = await run.backend.exec(
    { containerId: run.containerId, command, env: run.env, workdir: run.workdir },
    { stdout: run.stdout, stderr: run.stderr, tty: false, signal: run.signal },
  );

  run.signal.throwIfAborted();

  if (code !== 0) {
    throw new LauncherError(
      `setup: ${shown(command)} exited with code ${code}, so pi did not start`,
      "fix or remove that command in setup",
    );
  }
};

export const runSetup = (run: SetupRun) =>
  run.commands.reduce(
    (previous, command) => previous.then(() => runCommand(run, command)),
    Promise.resolve(),
  );
