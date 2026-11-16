import { type Dirent, readdirSync, statSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, VmApplied } from "../../backend/index.ts";
import { validateConfig } from "../../config/index.ts";
import { errorMessage, LauncherError, launcherRoot } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeNotices } from "../deps.ts";
import { createPlainPrompts } from "../prompt/plain.ts";
import { createRichPrompts } from "../prompt/rich.ts";
import { findTerminal, isSet, realTimers, withTerminal } from "../prompt/terminal.ts";
import type { Ui } from "../prompt/types.ts";
import { applyPlan, lineFrontEnd } from "../setup/apply.ts";
import { detectHost } from "../setup/detect.ts";
import { readDocument, writeDocument } from "../setup/document.ts";
import { runSetup, type SetupInput } from "../setup/flow.ts";
import { answersForYes, configuredRoots, isFirstRun, planOf } from "../setup/plan.ts";
import { invalidText } from "../setup/screens.ts";
import type {
  Answers,
  ApplyEffects,
  ConfigDocument,
  DocumentRead,
  SetupIo,
  SharePlan,
} from "../setup/types.ts";
import { assertVmFitsHost, prepareVmDirs, vmBusyCount, vmSharesFor } from "../vm.ts";

export const YES_FLAG = "--yes";

const SETUP_HINT =
  "pass --yes to keep the current settings and apply them; PI_SANDBOX_ROOTS names project folders";

const SIGNAL_EXITS = { SIGTERM: 143, SIGHUP: 129 } as const;

interface SetupContext {
  backend: Backend;
  stateDir: string;
  configFile: string;
}

const contextOf = (deps: CliDeps): SetupContext => {
  const paths = pathsOf(deps);

  return { backend: deps.backend(), stateDir: paths.stateDir, configFile: paths.userConfigFile };
};

const readConfig = async (file: string): Promise<DocumentRead> => {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw new LauncherError(`could not read ${file}: ${errorMessage(error)}`);
  });

  return readDocument(file, text);
};

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

const invalidConfig = (file: string, read: Extract<DocumentRead, { ok: false }>) => {
  const { problem, fix } = invalidText(read);

  return new LauncherError(`${file} ${problem}: ${read.message}`, fix);
};

const validFile = (document: ConfigDocument) => {
  try {
    validateConfig(document.value);
  } catch (error) {
    throw new LauncherError(errorMessage(error), `fix ${document.file}`);
  }
};

const acceptAll = async (deps: CliDeps) => {
  const context = contextOf(deps);
  const read = await readConfig(context.configFile);

  if (!read.ok) {
    throw invalidConfig(context.configFile, read);
  }

  const document = read.document;

  validFile(document);

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

  const streams = { out: deps.stdout, err: deps.stderr, timers: { ...realTimers, now: deps.now } };

  return applyPlan(lineFrontEnd(streams, facts), effectsFor(deps, context), document, { plan, answers });
};

const ioOf = (ui: Ui): SetupIo => ({
  prompts: ui.mode === "rich" ? createRichPrompts(ui) : createPlainPrompts(ui),
  plain: ui.mode === "plain",
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
