import { type Dirent, readdirSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { type Backend, type VmApplied, vmSizeText } from "../../backend/index.ts";
import { validateConfigFile } from "../../config/index.ts";
import { errorMessage, LauncherError, launcherRoot, readText } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeLine, writeNotices } from "../deps.ts";
import { createPlainPrompts } from "../prompt/plain.ts";
import { createRichPrompts } from "../prompt/rich.ts";
import { findTerminal, realTimers, withTerminal } from "../prompt/terminal.ts";
import type { Ui } from "../prompt/types.ts";
import { detectHost } from "../setup/detect.ts";
import { readDocument, writeDocument } from "../setup/document.ts";
import { runSetup, type SetupInput } from "../setup/flow.ts";
import { tildeForm } from "../setup/folders.ts";
import { answersForYes, configuredRoots, isFirstRun, isPlanEmpty, planOf } from "../setup/plan.ts";
import { partsText } from "../setup/screens.ts";
import type {
  Answers,
  ApplyEffects,
  Change,
  ConfigDocument,
  DocumentRead,
  SetupIo,
  SharePlan,
  VmAction,
} from "../setup/types.ts";
import { assertVmFitsHost, prepareVmDirs, vmBusyCount, vmSharesFor } from "../vm.ts";

export const YES_FLAG = "--yes";

const SETUP_HINT =
  "pass --yes to keep the current settings and apply them; PI_SANDBOX_ROOTS names project folders";

const SIGNAL_EXITS = { SIGTERM: 143, SIGHUP: 129 } as const;

const HEARTBEAT_MS = 15_000;

const NOTHING_TO_CHANGE = "nothing to change: the config and the sandbox VM match";

const STOPPED_LINE = "the sandbox VM is stopped; the next pi starts it with these settings";

type Running = Extract<VmAction, { kind: "create" | "restart" }>;

interface SetupContext {
  backend: Backend;
  stateDir: string;
  configFile: string;
}

const isSet = (value: string | undefined) => value !== undefined && value !== "";

const contextOf = (deps: CliDeps): SetupContext => {
  const paths = pathsOf(deps);

  return { backend: deps.backend(), stateDir: paths.stateDir, configFile: paths.userConfigFile };
};

const readConfig = async (file: string): Promise<DocumentRead> => readDocument(file, await readText(file));

const detectFor = (deps: CliDeps, context: SetupContext) => (document: ConfigDocument) =>
  detectHost({
    home: deps.home,
    cwd: deps.cwd,
    env: deps.env,
    machine: deps.machine,
    stateDir: context.stateDir,
    configFile: context.configFile,
    docsFile: join(launcherRoot(), "CONFIGURATION.md"),
    configRoots: configuredRoots(document),
    firstRun: isFirstRun(document),
    backend: context.backend,
    statfs: deps.statfs ?? statfs,
  });

const sharePlanFor =
  (deps: CliDeps) =>
  (roots: Answers["roots"], facts: { home: string }): SharePlan => {
    if (roots === "home") {
      return { shares: [{ location: facts.home, writable: true }], exact: false };
    }

    try {
      return { shares: vmSharesFor(deps, { roots })?.shares ?? [], exact: true };
    } catch (error) {
      return { problem: errorMessage(error) };
    }
  };

const effectsFor = (deps: CliDeps, context: SetupContext): ApplyEffects => ({
  write: writeDocument,
  vm: async (action, progress): Promise<VmApplied> => {
    if (action.kind !== "create" && action.kind !== "restart") {
      return "unchanged";
    }

    assertVmFitsHost(deps, action.size);

    await prepareVmDirs(deps);

    return context.backend.vm.apply(
      {
        size: action.size,
        shares: action.shares,
        exactShares: action.kind === "restart" ? action.exactShares : true,
      },
      { busy: () => vmBusyCount(context.backend, context.stateDir), progress },
    );
  },
});

const isFolderEntry = (dir: string, entry: Dirent) =>
  entry.isDirectory() ||
  (entry.isSymbolicLink() &&
    statSync(join(dir, entry.name), { throwIfNoEntry: false })?.isDirectory() === true);

const folderNames = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => isFolderEntry(dir, entry))
    .map((entry) => entry.name);

const invalidConfig = (file: string, read: Extract<DocumentRead, { ok: false }>) =>
  read.kind === "json"
    ? new LauncherError(
        `${file} is not valid JSON: ${read.message}`,
        "fix the file, or move it away to start over, then run pi sandbox init again",
      )
    : new LauncherError(read.message, `fix that key in ${file}, then run pi sandbox init again`);

const VERBS: Record<Change["kind"], string> = { add: "added", change: "changed", remove: "removed" };

const changesText = (changes: Change[]) =>
  changes.map((change) => `${VERBS[change.kind]} ${change.key}`).join(", ");

const sessionsText = (count: number) =>
  count === 1 ? "1 pi session is running" : `${count} pi sessions are running`;

const keptLine = (sessions: number) =>
  `kept the sandbox VM as it is: ${sessionsText(sessions)}; the first pi started after they exit applies the new settings`;

const sharedText = (roots: Answers["roots"]) => (roots === "home" ? "your whole home (~)" : roots.join(", "));

const startLine = (action: Running, roots: Answers["roots"]) => {
  const target = `${vmSizeText(action.size)}, sharing ${sharedText(roots)}`;

  return action.kind === "create"
    ? `creating the sandbox VM: ${target}`
    : `restarting the sandbox VM with the new ${partsText(action.parts)}: ${target}`;
};

const secondsOf = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;

const doneLine = (applied: VmApplied, action: Running, elapsed: string) => {
  if (applied === "created") {
    return `created the sandbox VM in ${elapsed}`;
  }

  if (applied === "restarted") {
    const parts = action.kind === "restart" ? action.parts : ["size" as const, "folders" as const];

    return `restarted the sandbox VM in ${elapsed} with the new ${partsText(parts)}`;
  }

  if (applied === "stopped") {
    return STOPPED_LINE;
  }

  return typeof applied === "object" ? keptLine(applied.deferred) : "the sandbox VM already matches";
};

const runVm = async (deps: CliDeps, effects: ApplyEffects, action: Running, roots: Answers["roots"]) => {
  writeLine(deps.stdout, startLine(action, roots));

  const started = deps.now();
  const stopHeartbeat = realTimers.every(HEARTBEAT_MS, () =>
    writeLine(deps.stdout, `  still working (${secondsOf(deps.now() - started)})`),
  );

  try {
    const applied = await effects.vm(action, () => undefined);

    writeLine(deps.stdout, doneLine(applied, action, secondsOf(deps.now() - started)));
  } finally {
    stopHeartbeat();
  }
};

const applyVmQuietly = async (
  deps: CliDeps,
  effects: ApplyEffects,
  action: VmAction,
  roots: Answers["roots"],
) => {
  if (action.kind === "create" || action.kind === "restart") {
    await runVm(deps, effects, action, roots);

    return;
  }

  if (action.kind === "unknown") {
    writeNotices(deps, [
      `could not check the sandbox VM (${action.reason}); the next pi start applies the size and the shares`,
    ]);
  }

  if (action.kind === "defer") {
    writeLine(deps.stdout, keptLine(action.sessions));
  }

  if (action.kind === "on-next-start") {
    writeLine(deps.stdout, STOPPED_LINE);
  }
};

const acceptAll = async (deps: CliDeps) => {
  const context = contextOf(deps);
  const read = await readConfig(context.configFile);

  if (!read.ok) {
    throw invalidConfig(context.configFile, read);
  }

  const document = read.document;

  validateConfigFile(document.value, document.file);

  const facts = await detectFor(deps, context)(document);
  const { answers, notices } = answersForYes(document, facts, deps.env);

  writeNotices(deps, notices);

  const plan = planOf(document, answers, facts, sharePlanFor(deps)(answers.roots, facts));

  if (plan.problems.length > 0) {
    throw new LauncherError(plan.problems.join("; "), `fix ${context.configFile}`);
  }

  if (plan.vm.kind === "create" || plan.vm.kind === "restart") {
    assertVmFitsHost(deps, plan.vm.size);
  }

  if (isPlanEmpty(plan)) {
    writeLine(deps.stdout, NOTHING_TO_CHANGE);

    return 0;
  }

  const effects = effectsFor(deps, context);

  if (plan.changes.length > 0) {
    await effects.write(document, plan.text);

    writeLine(deps.stdout, `saved ${tildeForm(context.configFile, deps.home)}: ${changesText(plan.changes)}`);
  }

  await applyVmQuietly(deps, effects, plan.vm, answers.roots);

  return 0;
};

const ioOf = (ui: Ui): SetupIo => ({
  prompts: ui.mode === "rich" ? createRichPrompts(ui) : createPlainPrompts(ui),
  plain: ui.mode === "plain",
  columns: ui.columns,
  now: ui.timers.now,
});

const signalExit = () => {
  const state: { resolve?: (code: number) => void } = {};
  const exited = new Promise<number>((resolve) => {
    state.resolve = resolve;
  });

  return { exited, onSignal: (signal: keyof typeof SIGNAL_EXITS) => state.resolve?.(SIGNAL_EXITS[signal]) };
};

const ask = (deps: CliDeps, ui: Ui) => {
  const context = contextOf(deps);
  const signal = signalExit();

  const setup = async () => {
    const input: SetupInput = {
      read: await readConfig(context.configFile),
      configFile: context.configFile,
      home: deps.home,
      env: deps.env,
      readdir: folderNames,
      detect: detectFor(deps, context),
      sharePlan: sharePlanFor(deps),
    };

    return runSetup(ioOf(ui), input, effectsFor(deps, context));
  };

  const guards = { signals: deps.signals ?? process, exits: process, onSignal: signal.onSignal };

  return withTerminal(ui, guards, () => Promise.race([setup(), signal.exited]));
};

export const initCommand = async (deps: CliDeps, args: string[]) => {
  if (args.includes(YES_FLAG)) {
    return acceptAll(deps);
  }

  if (isSet(deps.env.CI)) {
    throw new LauncherError("pi sandbox init asks questions, and CI is set", SETUP_HINT);
  }

  const ui = findTerminal({
    stdin: deps.terminal.stdin,
    stderr: deps.terminal.stderr,
    env: deps.env,
    openTty: deps.openTty,
  });

  if (ui === undefined) {
    throw new LauncherError("pi sandbox init asks questions and needs a terminal", SETUP_HINT);
  }

  return ask(deps, ui);
};
