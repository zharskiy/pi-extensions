import { type Dirent, readdirSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, VmApplied } from "../../backend/index.ts";
import { validateConfigFile } from "../../config/index.ts";
import { errorMessage, LauncherError, launcherRoot } from "../../shared/index.ts";
import { type CliDeps, pathsOf, writeNotices } from "../deps.ts";
import { createPlainPrompts } from "../prompt/plain.ts";
import { createRichPrompts } from "../prompt/rich.ts";
import { findTerminal, isSet, realTimers, withTerminal } from "../prompt/terminal.ts";
import type { Ui } from "../prompt/types.ts";
import { applyPlan, lineFrontEnd } from "../setup/apply.ts";
import { detectHost } from "../setup/detect.ts";
import { readConfigText, readDocument, writeDocument } from "../setup/document.ts";
import { runSetup, type SetupInput } from "../setup/flow.ts";
import { answersForYes, configuredRoots, isFirstRun, planOf } from "../setup/plan.ts";
import { createReview } from "../setup/review.ts";
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

const readConfig = async (file: string): Promise<DocumentRead> =>
  readDocument(file, await readConfigText(file));

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
      return { shares: [{ location: facts.home, writable: true }], exact: false, notices: [] };
    }

    try {
      const planned = vmSharesFor(deps, { roots });

      return {
        shares: planned?.shares ?? [],
        exact: true,
        notices: [...(planned?.nested ?? []), ...(planned?.notices ?? [])],
      };
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

    assertVmFitsHost(deps, action.size, true);

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

  const plan = planOf(document, answers, facts, sharePlanFor(deps)(answers.roots, facts));

  writeNotices(deps, [...notices, ...plan.notices]);

  if (plan.problems.length > 0) {
    throw new LauncherError(plan.problems.join("; "), `fix ${context.configFile}`);
  }

  if (plan.vm.kind === "create" || plan.vm.kind === "restart") {
    assertVmFitsHost(deps, plan.vm.size, true);
  }

  const streams = { out: deps.stdout, err: deps.stderr, timers: { ...realTimers, now: deps.now } };
  const state = { answers, touched: new Set<never>() };
  const review = createReview(document, facts, deps.env).lines(
    state,
    { ...plan, notices: [] },
    { plain: true, table: true },
  );

  const front = lineFrontEnd(streams, facts, review(Number.POSITIVE_INFINITY));

  return applyPlan(front, effectsFor(deps, context), document, { plan, answers });
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
