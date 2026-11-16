import type { VmSpec } from "../../backend/index.ts";
import { BACK, Cancelled, type Choice, type Reply } from "../prompt/types.ts";
import { applyPlan, noteOf } from "./apply.ts";
import { valueAt } from "./document.ts";
import { addedRootProblem, tildeForm } from "./folders.ts";
import { firstRunSteps, initialAnswers, isPlanEmpty, ownedProblems, planOf, vmBounds } from "./plan.ts";
import {
  applyLines,
  automaticLabel,
  CANCELLED,
  CHECKING,
  DISCARD_CONFIRM,
  FIX_FOLDERS,
  FOLDERS_DETAIL,
  FOLDERS_PLAIN_HELP,
  FOLDERS_TITLE,
  folderTag,
  HOME_CONFIRM,
  HOME_ROOTS,
  HUB_SUMMARY_TITLE,
  type HubRow,
  hubRowLines,
  INTRO_TITLE,
  INVALID_CONFIG_END,
  INVALID_JSON_END,
  introLines,
  invalidConfigLines,
  invalidJsonLines,
  NO_FOLDER_FOUND,
  NOTHING_CHANGED,
  NOTHING_TO_DO,
  numberFields,
  OTHER_SETTINGS,
  rootsSummary,
  SEARCH_TIMED_OUT,
  type Step,
  sharedNowLine,
  sharesHome,
  shownSize,
  sizeText,
  stepTitle,
  type Tag,
  vmCollapsed,
  vmEditorDetail,
  WRITE_BACK_DETAIL,
  WRITE_BACK_TITLE,
  wrapped,
} from "./screens.ts";
import type {
  Answers,
  ApplyEffects,
  ConfigDocument,
  DocumentRead,
  HostFacts,
  Outcome,
  OwnedProblem,
  Plan,
  Section,
  SetupIo,
  SharePlan,
} from "./types.ts";

interface WizardContext {
  document: ConfigDocument;
  facts: HostFacts;
  env: NodeJS.ProcessEnv;
  readdir: (dir: string) => string[];
  sharePlan: (roots: Answers["roots"], facts: HostFacts) => SharePlan;
}

export interface SetupInput {
  read: DocumentRead;
  configFile: string;
  home: string;
  env: NodeJS.ProcessEnv;
  readdir: (dir: string) => string[];
  detect: (document: ConfigDocument) => Promise<HostFacts>;
  sharePlan: (roots: Answers["roots"], facts: HostFacts) => SharePlan;
}

interface State {
  answers: Answers;
  touched: ReadonlySet<Section>;
  added: readonly string[];
}

interface Pending {
  added: string[];
  listed: string[];
  checked: string[];
}

type HubChoice = "apply" | "done" | "cancel" | Section;

const ADD = "\u0000add";

const VM_FIELDS: readonly (keyof VmSpec)[] = ["cpus", "memoryGiB", "diskGiB"];

const SECTION_KEYS: Record<Section, (key: string) => boolean> = {
  folders: (key) => key === "workspaceRoots" || key.startsWith("workspaceRoots."),
  vm: (key) => key.startsWith("vm."),
  writeBack: (key) => key.startsWith("writeBack."),
};

const SECTION_LABELS: Record<Section, string> = {
  folders: "Project folders",
  vm: "VM size",
  writeBack: "Settings write-back",
};

const touchedWith = (state: State, section: Section, answers: Answers): State => ({
  ...state,
  answers,
  touched: new Set([...state.touched, section]),
});

const withinBounds = (value: number, bound: { min: number; max: number }) =>
  Math.min(bound.max, Math.max(bound.min, value));

const createWizard = (io: SetupIo, context: WizardContext) => {
  const { prompts } = io;
  const { document, facts, env } = context;
  const problems = ownedProblems(document, { home: facts.home, env });
  const homeNow = sharesHome(facts);
  const sharedNow = firstRunSteps(document).length > 0 ? sharedNowLine(facts) : undefined;

  const planFor = (answers: Answers): Plan =>
    planOf(document, answers, facts, context.sharePlan(answers.roots, facts));

  const folderChoices = (state: State): Choice<string>[] => {
    const listed = facts.candidates.map((candidate) => ({
      value: candidate.stored,
      label: candidate.stored,
      tag: folderTag(candidate, facts.candidates, io.plain),
    }));
    const known = new Set(listed.map((choice) => choice.value));
    const chosen = state.answers.roots === "home" ? [] : state.answers.roots;
    const extra = [...chosen, ...state.added]
      .filter((root, index, all) => !known.has(root) && all.indexOf(root) === index)
      .map((root) => ({ value: root, label: root }));

    return [...listed, ...extra];
  };

  const rootProblem = (typed: string, state: Pending) =>
    addedRootProblem(typed, { home: facts.home, env, checked: state.checked, listed: state.listed });

  const added = (typed: string, state: Pending) => {
    const stored = tildeForm(typed.trim(), facts.home);

    state.added.push(stored);

    state.listed.push(stored);

    state.checked.push(stored);

    return { value: stored, label: stored };
  };

  const addFolder = async (state: Pending) => {
    const typed = await prompts.path({
      title: "Add a folder",
      initial: "~/",
      home: facts.home,
      readdir: context.readdir,
      enter: "add",
      validate: (value) => rootProblem(value, state),
      collapsed: () => undefined,
    });

    return typed === BACK ? undefined : added(typed, state);
  };

  const addTyped = (typed: string, state: Pending) => {
    const problem = rootProblem(typed, state);

    if (problem === undefined) {
      return added(typed, state);
    }

    prompts.note([`Error: ${problem}`]);

    return undefined;
  };

  const confirmHome = async (step: Step | undefined) => {
    const reply = await prompts.confirm({
      title: stepTitle(HOME_CONFIRM.title, step),
      detail: [HOME_CONFIRM.detail],
      yes: HOME_CONFIRM.yes,
      no: HOME_CONFIRM.no,
      initial: homeNow,
      collapsed: (yes) => (yes ? { title: SECTION_LABELS.folders, text: HOME_ROOTS } : undefined),
    });

    return reply === true;
  };

  const editFolders = async (state: State, step: Step | undefined): Promise<Reply<State>> => {
    const choices = folderChoices(state);
    const checked = state.answers.roots === "home" ? [] : state.answers.roots;
    const pending = {
      added: [...state.added],
      listed: choices.map((choice) => choice.value),
      checked: [...checked],
    };
    const empty = choices.length === 0;
    const now = sharedNow === undefined ? [] : [sharedNow];
    const searchNote = facts.searchTimedOut === true ? SEARCH_TIMED_OUT : empty ? NO_FOLDER_FOUND : undefined;
    const reply = await prompts.multiselect<string>({
      title: stepTitle(FOLDERS_TITLE, step),
      detail: [FOLDERS_DETAIL, ...now, ...(searchNote === undefined ? [] : ["", searchNote])],
      choices: [
        ...choices,
        { value: ADD, label: empty ? "+ Add a folder…" : "+ Add another folder…", action: true },
      ],
      checked,
      onAction: async (_value, typed) =>
        typed === undefined ? addFolder(pending) : addTyped(typed, pending),
      escape: step?.index === 1 ? "cancel" : "back",
      collapsed: (values) =>
        values.length > 0 ? { title: SECTION_LABELS.folders, text: rootsSummary(values) } : undefined,
      plain: { help: FOLDERS_PLAIN_HELP, label: "Folders" },
    });

    if (reply === BACK) {
      return BACK;
    }

    const next = { ...state, added: pending.added };

    if (reply.length > 0) {
      return touchedWith(next, "folders", { ...state.answers, roots: reply });
    }

    if (await confirmHome(step)) {
      return touchedWith(next, "folders", { ...state.answers, roots: "home" });
    }

    return editFolders({ ...next, answers: { ...state.answers, roots: [] } }, step);
  };

  const customSize = async (size: VmSpec, index: number): Promise<Reply<VmSpec>> => {
    const key = VM_FIELDS[index];

    if (key === undefined) {
      return size;
    }

    const bounds = vmBounds(facts);
    const field = numberFields(facts, bounds)[key];
    const last = index === VM_FIELDS.length - 1;
    const value = await prompts.number({
      ...field,
      initial: withinBounds(size[key], bounds[key]),
      min: bounds[key].min,
      max: bounds[key].max,
      enter: last ? "done" : "next",
      collapsed: () => undefined,
    });

    if (value === BACK) {
      return index === 0 ? BACK : customSize(size, index - 1);
    }

    return customSize({ ...size, [key]: value }, index + 1);
  };

  const editVm = async (state: State, step: Step | undefined): Promise<Reply<State>> => {
    const title = SECTION_LABELS.vm;
    const reply = await prompts.select({
      title: stepTitle(title, step),
      detail: [vmEditorDetail(facts)],
      choices: [
        { value: "automatic" as const, label: "Automatic", tag: automaticLabel(facts) },
        { value: "custom" as const, label: "Custom…" },
      ],
      initial: state.answers.vm === "automatic" ? "automatic" : "custom",
      radio: true,
      collapsed: (value) =>
        value === "automatic" ? { title, text: vmCollapsed("automatic", facts, io.plain) } : undefined,
    });

    if (reply === BACK) {
      return BACK;
    }

    if (reply === "automatic") {
      return touchedWith(state, "vm", { ...state.answers, vm: "automatic" });
    }

    const size = await customSize(shownSize(state.answers.vm, facts), 0);

    if (size === BACK) {
      return editVm(state, step);
    }

    const text = vmCollapsed(size, facts, io.plain);

    noteOf(io, io.plain ? [`${title}: ${text}`, ""] : [title, text, ""], io.plain ? "rail" : "step");

    return touchedWith(state, "vm", { ...state.answers, vm: size });
  };

  const editWriteBack = async (state: State, step: Step | undefined): Promise<Reply<State>> => {
    const reply = await prompts.confirm({
      title: stepTitle(WRITE_BACK_TITLE, step),
      detail: [WRITE_BACK_DETAIL],
      yes: "Yes (on)",
      no: "No (off)",
      initial: state.answers.writeBack,
      collapsed: (value) => ({ title: SECTION_LABELS.writeBack, text: value ? "on" : "off" }),
    });

    return reply === BACK ? BACK : touchedWith(state, "writeBack", { ...state.answers, writeBack: reply });
  };

  const EDITORS: Record<Section, (state: State, step: Step | undefined) => Promise<Reply<State>>> = {
    folders: editFolders,
    vm: editVm,
    writeBack: editWriteBack,
  };

  const runSteps = async (
    state: State,
    steps: readonly Section[],
    index: number,
  ): Promise<State | "leave"> => {
    const section = steps[index];

    if (section === undefined) {
      return state;
    }

    const reply = await EDITORS[section](state, { index: index + 1, count: steps.length });

    if (reply === BACK) {
      return index === 0 ? "leave" : runSteps(state, steps, index - 1);
    }

    return runSteps(reply, steps, index + 1);
  };

  const sectionProblems = (section: Section, state: State, plan: Plan): OwnedProblem[] => {
    const owned = state.touched.has(section)
      ? []
      : problems.filter((problem) => SECTION_KEYS[section](problem.key));
    const planned =
      section === "folders" ? plan.problems.map((message) => ({ key: "workspaceRoots", message })) : [];

    return [...owned, ...planned];
  };

  const tagOf = (section: Section, state: State, plan: Plan): Tag => {
    const touched = state.touched.has(section);

    if (sectionProblems(section, state, plan).length > 0) {
      return "invalid";
    }

    if (section === "vm" && state.answers.vm === "automatic") {
      return "automatic";
    }

    if (section === "writeBack" && valueAt(plan.next, ["writeBack", "enabled"]) === undefined) {
      return "default";
    }

    const changes = plan.changes.filter((change) => SECTION_KEYS[section](change.key));

    if (changes.length === 0) {
      return touched ? "chosen" : "current";
    }

    return touched && changes.every((change) => change.kind === "add") ? "chosen" : "changed";
  };

  const sectionValue = (section: Section, answers: Answers) => {
    if (section === "folders") {
      return rootsSummary(answers.roots);
    }

    return section === "vm" ? sizeText(shownSize(answers.vm, facts)) : answers.writeBack ? "on" : "off";
  };

  const rowsOf = (state: State, plan: Plan): HubRow[] =>
    (["folders", "vm", "writeBack"] as const).map((section) => ({
      label: SECTION_LABELS[section],
      value: sectionValue(section, state.answers),
      tag: tagOf(section, state, plan),
      problems: sectionProblems(section, state, plan).map((problem) => problem.message),
    }));

  const hubDetail =
    (state: State, plan: Plan, notice: string | undefined, table: boolean) => (room: number) => {
      const done = isPlanEmpty(plan) && plan.problems.length === 0;
      const shape = { existed: document.text !== undefined, indent: document.indent };
      const effect = done ? wrapped([NOTHING_TO_DO], room) : applyLines(plan, facts, shape, room, io.plain);
      const rows = table || io.plain ? hubRowLines(rowsOf(state, plan), room, io.plain) : [];
      const framed = table && !io.plain;

      return [
        ...(framed ? [HUB_SUMMARY_TITLE] : []),
        ...rows,
        ...(framed ? [""] : []),
        ...(notice === undefined ? [] : [...wrapped([notice], room), ""]),
        ...effect,
        ...(io.plain ? [] : ["", ...wrapped([OTHER_SETTINGS], room), ""]),
      ];
    };

  const hubSummary = (state: State, plan: Plan, notice: string | undefined, table: boolean) => {
    const summary = hubDetail(state, plan, notice, table);

    if (io.plain) {
      return { detail: summary };
    }

    prompts.note(summary);

    return {};
  };

  const leave = async (state: State, plan: Plan, hub: () => Promise<Outcome>): Promise<Outcome> => {
    const dirty = state.touched.size > 0 && !isPlanEmpty(plan);

    if (!dirty) {
      return { kind: "cancelled" };
    }

    const sure = await prompts.confirm({
      title: DISCARD_CONFIRM.title,
      yes: DISCARD_CONFIRM.yes,
      no: DISCARD_CONFIRM.no,
      initial: false,
      collapsed: () => undefined,
    });

    return sure === true ? { kind: "cancelled" } : hub();
  };

  const hub = async (state: State, notice?: string, table = true): Promise<Outcome> => {
    const plan = planFor(state.answers);
    const done = isPlanEmpty(plan) && plan.problems.length === 0;
    const changes: Choice<HubChoice>[] = [
      { value: "folders", label: "Change project folders" },
      { value: "vm", label: "Change VM size" },
      { value: "writeBack", label: "Change settings write-back" },
    ];
    const choices: Choice<HubChoice>[] = done
      ? [{ value: "done", label: "Done" }, ...changes]
      : [{ value: "apply", label: "Apply" }, ...changes, { value: "cancel", label: "Cancel" }];
    const reply = await prompts.select<HubChoice>({
      title: "Review",
      ...hubSummary(state, plan, notice, table),
      choices,
      escape: done ? "done" : "cancel",
      collapsed: (value) =>
        value === "apply" && plan.problems.length === 0 && !io.plain
          ? { title: "Review", text: "Apply" }
          : undefined,
    });

    if (reply === "done" || (reply === BACK && done)) {
      return { kind: "unchanged" };
    }

    if (reply === BACK || reply === "cancel") {
      return leave(state, plan, () => hub(state));
    }

    if (reply === "apply") {
      return plan.problems.length > 0
        ? hub(state, FIX_FOLDERS)
        : { kind: "apply", plan, answers: state.answers };
    }

    const edited = await EDITORS[reply](state, undefined);

    return hub(edited === BACK ? state : edited);
  };

  const run = async (): Promise<Outcome> => {
    const start: State = { answers: initialAnswers(document, facts, env), touched: new Set(), added: [] };
    const steps = firstRunSteps(document);
    const stepped = await runSteps(start, steps, 0);

    return stepped === "leave" ? { kind: "cancelled" } : hub(stepped, undefined, steps.length === 0);
  };

  return { run };
};

const runWizard = (io: SetupIo, context: WizardContext): Promise<Outcome> => createWizard(io, context).run();

const invalidScreen = (io: SetupIo, input: SetupInput, read: Extract<DocumentRead, { ok: false }>) => {
  const json = read.kind === "json";
  const lines = json
    ? invalidJsonLines(input.configFile, input.home, read.message)
    : invalidConfigLines(input.configFile, input.home, read.message);

  noteOf(io, [...lines, ""]);

  noteOf(io, [json ? INVALID_JSON_END : INVALID_CONFIG_END], "end");

  return 1;
};

const detectWith = (io: SetupIo, input: SetupInput, document: ConfigDocument) =>
  io.prompts.task({
    title: "",
    interruptWarning: "",
    run: (update) => {
      update(CHECKING);

      return input.detect(document);
    },
  });

const wizardExit = async (
  io: SetupIo,
  input: SetupInput,
  effects: ApplyEffects,
  document: ConfigDocument,
) => {
  const facts = await detectWith(io, input, document);

  noteOf(io, introLines(facts, firstRunSteps(document).length > 0, io.plain));

  const outcome = await runWizard(io, {
    document,
    facts,
    env: input.env,
    readdir: input.readdir,
    sharePlan: input.sharePlan,
  });

  if (outcome.kind === "cancelled") {
    noteOf(io, [CANCELLED], "end");

    return 130;
  }

  if (outcome.kind === "unchanged") {
    noteOf(io, [NOTHING_CHANGED], "end");

    return 0;
  }

  return applyPlan(io, effects, { document, facts }, outcome);
};

export const runSetup = async (io: SetupIo, input: SetupInput, effects: ApplyEffects): Promise<number> => {
  noteOf(io, io.plain ? [INTRO_TITLE] : [INTRO_TITLE, ""], io.plain ? "rail" : "start");

  if (!input.read.ok) {
    return invalidScreen(io, input, input.read);
  }

  const document = input.read.document;

  try {
    return await wizardExit(io, input, effects, document);
  } catch (error) {
    if (error instanceof Cancelled) {
      noteOf(io, [CANCELLED], "end");

      return 130;
    }

    throw error;
  }
};
