import { type Dirent, readdirSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, VmApplied } from "../../backend/index.ts";
import { getPath, validateConfigFile } from "../../config/index.ts";
import { errorMessage, isJsonObject, LauncherError, launcherRoot } from "../../shared/index.ts";
import { hostBinds } from "../../workspace/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf, writeNotices } from "../deps.ts";
import { createPlainPrompts } from "../prompt/plain.ts";
import { createRichPrompts } from "../prompt/rich.ts";
import { findTerminal, isSet, realTimers, withTerminal } from "../prompt/terminal.ts";
import type { Timers, Ui } from "../prompt/types.ts";
import { applyPlan, stepsFrontEnd } from "../setup/apply.ts";
import { detectHost } from "../setup/detect.ts";
import { readConfigText, readDocument, writeDocument } from "../setup/document.ts";
import { runSetup, type SetupInput } from "../setup/flow.ts";
import { tildeForm } from "../setup/folders.ts";
import { answersForYes, configuredRoot, isFirstRun, NO_ROOT, planOf } from "../setup/plan.ts";
import { invalidText, NOTHING_TO_DO, nextCommand } from "../setup/screens.ts";
import type {
  Answers,
  ApplyEffects,
  ApplyEvent,
  ApplyFrontEnd,
  ConfigDocument,
  DocumentRead,
  HostFacts,
  SetupIo,
  SharePlan,
} from "../setup/types.ts";
import { type Steps, stepsOf } from "../steps.ts";
import { assertVmFitsHost, prepareVmDirs, vmSharesFor } from "../vm.ts";

export const YES_FLAG = "--yes";

const SETUP_HINT =
  "pass --yes to keep the current settings and apply them; PINATA_ROOT names the folder that holds your projects";

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
    configRoot: configuredRoot(document),
    firstRun: isFirstRun(document),
    backend: context.backend,
    statfs: deps.statfs ?? statfs,
  });

const bindEntriesOf = (read: DocumentRead) => {
  const binds = read.ok ? getPath(read.document.value, "mounts.binds") : undefined;

  return (Array.isArray(binds) ? binds : []).filter(
    (entry): entry is { source: string; target: string } =>
      isJsonObject(entry) && typeof entry.source === "string" && typeof entry.target === "string",
  );
};

const vmPlanFor = (deps: CliDeps, read: DocumentRead, root: string) => {
  const binds = hostBinds(bindEntriesOf(read), { home: deps.home, env: deps.env, roots: [root] });

  return vmSharesFor(deps, root, binds);
};

const sharePlanFor =
  (deps: CliDeps, read: DocumentRead) =>
  (root: Answers["root"]): SharePlan => {
    if (root === undefined) {
      return { problem: NO_ROOT };
    }

    try {
      return { shares: vmPlanFor(deps, read, root).shares };
    } catch (error) {
      return { problem: errorMessage(error) };
    }
  };

const shareNoticesFor = (deps: CliDeps, read: DocumentRead, root: Answers["root"]) => {
  if (root === undefined) {
    return [];
  }

  try {
    return vmPlanFor(deps, read, root).notices;
  } catch {
    return [];
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
      { size: action.size, shares: action.shares },
      { busy: () => vmSessions(context.backend, context.stateDir), progress },
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

type FrontOf = (facts: HostFacts, timers: Timers) => ApplyFrontEnd;

export const planAll = async (deps: CliDeps, factsFor = (facts: HostFacts) => facts) => {
  const context = contextOf(deps);
  const read = await readConfig(context.configFile);

  if (!read.ok) {
    throw invalidConfig(context.configFile, read);
  }

  const document = read.document;

  validateConfigFile(document.value, document.file);

  const facts = factsFor(await detectFor(deps, context)(document));
  const answers = answersForYes(document, facts, deps.env);
  const plan = planOf(document, answers, facts, sharePlanFor(deps, read)(answers.root));

  if (plan.problems.length > 0) {
    throw new LauncherError(plan.problems.join("; "), `fix ${context.configFile}`);
  }

  if (plan.vm.kind === "create" || plan.vm.kind === "restart") {
    assertVmFitsHost(deps, plan.vm.size);
  }

  return { context, read, document, facts, answers, plan };
};

export type Planned = Awaited<ReturnType<typeof planAll>>;

export const applyAll = (deps: CliDeps, planned: Planned, frontOf: FrontOf) => {
  const { context, read, document, facts, answers, plan } = planned;

  writeNotices(deps, shareNoticesFor(deps, read, answers.root));

  const front = frontOf(facts, { ...realTimers, now: deps.now });

  return applyPlan(front, effectsFor(deps, context), document, { plan, answers });
};

export const acceptAll = async (deps: CliDeps, frontOf: FrontOf) =>
  applyAll(deps, await planAll(deps), frontOf);

const closingFrontEnd = (steps: Steps, facts: HostFacts, timers: Timers): ApplyFrontEnd => {
  const front = stepsFrontEnd(steps, facts, timers);

  const report = (event: ApplyEvent) => {
    if (event.kind === "nothing-to-do") {
      steps.close(NOTHING_TO_DO);

      return;
    }

    if (event.kind === "done" && event.vmReady) {
      steps.close("The sandbox is ready.", [
        ["Start", nextCommand(event.root, facts)],
        ["Settings", tildeForm(facts.configFile, facts.home)],
        ["Check", "pinata doctor"],
      ]);

      return;
    }

    if (event.kind === "done") {
      steps.close("The settings are saved.");

      return;
    }

    front.report(event);
  };

  return { ...front, report };
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
    const read = await readConfig(context.configFile);
    const input: SetupInput = {
      read,
      configFile: context.configFile,
      home: deps.home,
      env: deps.env,
      readdir: folderNames,
      detect: detectFor(deps, context),
      sharePlan: sharePlanFor(deps, read),
    };

    return runSetup(ioOf(ui), input, effectsFor(deps, context));
  };

  const guards = { signals: deps.signals ?? process, exits: process, onSignal: signal.onSignal };

  return withTerminal(ui, guards, () => Promise.race([setup(), signal.exited]));
};

export const initCommand = async (deps: CliDeps, args: string[]) => {
  if (args.includes(YES_FLAG)) {
    const steps = stepsOf(deps);

    return acceptAll(deps, (facts, timers) => closingFrontEnd(steps, facts, timers));
  }

  if (isSet(deps.env.CI)) {
    throw new LauncherError("pinata init asks questions, and CI is set", SETUP_HINT);
  }

  const ui = findTerminal({
    stdin: deps.terminal.stdin,
    stderr: deps.terminal.stderr,
    env: deps.env,
    openTty: deps.openTty,
  });

  if (ui === undefined) {
    throw new LauncherError("pinata init asks questions and needs a terminal", SETUP_HINT);
  }

  return ask(deps, ui);
};
