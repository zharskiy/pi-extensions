import type { VmSpec } from "../../backend/index.ts";
import { BACK, Cancelled, type Choice, type Reply } from "../prompt/types.ts";
import { applyPlan, noteOf, wizardFrontEnd } from "./apply.ts";
import { VM_KEYS } from "./document.ts";
import { tildeForm, typedRootProblem } from "./folders.ts";
import { firstRunSteps, initialAnswers, isPlanEmpty, planOf, vmBounds } from "./plan.ts";
import { createReview, SECTION_LABELS } from "./review.ts";
import {
  automaticLabel,
  CANCELLED,
  CHECKING,
  DISCARD_CONFIRM,
  FIX_FOLDERS,
  FOLDERS_DETAIL,
  FOLDERS_TITLE,
  folderTag,
  INTRO_TITLE,
  introLines,
  invalidLines,
  NO_FOLDER_FOUND,
  NOTHING_CHANGED,
  numberFields,
  OTHER_FOLDER_TITLE,
  rootSummary,
  SEARCH_TIMED_OUT,
  type Step,
  sharedNowLine,
  shownSize,
  stepTitle,
  vmCollapsed,
  vmEditorDetail,
  WRITE_BACK_DETAIL,
  WRITE_BACK_TITLE,
} from "./screens.ts";
import type {
  Answers,
  ApplyEffects,
  ConfigDocument,
  DocumentRead,
  HostFacts,
  Outcome,
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
  sharePlan: (root: Answers["root"]) => SharePlan;
}

export interface SetupInput {
  read: DocumentRead;
  configFile: string;
  home: string;
  env: NodeJS.ProcessEnv;
  readdir: (dir: string) => string[];
  detect: (document: ConfigDocument) => Promise<HostFacts>;
  sharePlan: (root: Answers["root"]) => SharePlan;
}

interface State {
  answers: Answers;
  touched: ReadonlySet<Section>;
}

type HubChoice = "apply" | "done" | "cancel" | Section;

const OTHER = "\u0000other";

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
  const review = createReview(document, facts, env);
  const sharedNow = firstRunSteps(document).length > 0 ? sharedNowLine(facts) : undefined;

  const planFor = (answers: Answers): Plan =>
    planOf(document, answers, facts, context.sharePlan(answers.root));

  const folderChoices = (state: State): Choice<string>[] => {
    const listed = facts.candidates.map((candidate) => ({
      value: candidate.stored,
      label: candidate.stored,
      tag: folderTag(candidate, facts.candidates, io.plain),
    }));
    const root = state.answers.root;
    const known = root === undefined || listed.some((choice) => choice.value === root);

    return known ? listed : [...listed, { value: root, label: root }];
  };

  const typedFolder = async (): Promise<Reply<string>> => {
    const typed = await prompts.path({
      title: OTHER_FOLDER_TITLE,
      initial: "~/",
      home: facts.home,
      readdir: context.readdir,
      enter: "choose",
      validate: (value) => typedRootProblem(value, { home: facts.home, env }),
      collapsed: () => undefined,
    });

    return typed === BACK ? BACK : tildeForm(typed.trim(), facts.home);
  };

  const editFolders = async (state: State, step: Step | undefined): Promise<Reply<State>> => {
    const choices = folderChoices(state);
    const now = sharedNow === undefined ? [] : [sharedNow];
    const empty = choices.length === 0;
    const searchNote = facts.searchTimedOut === true ? SEARCH_TIMED_OUT : empty ? NO_FOLDER_FOUND : undefined;
    const reply = await prompts.select<string>({
      title: stepTitle(FOLDERS_TITLE, step),
      detail: [FOLDERS_DETAIL, ...now, ...(searchNote === undefined ? [] : ["", searchNote])],
      choices: [...choices, { value: OTHER, label: empty ? "Type a folder…" : "Another folder…" }],
      initial: state.answers.root ?? choices[0]?.value ?? OTHER,
      radio: true,
      escape: step?.index === 1 ? "cancel" : "back",
      collapsed: (value) =>
        value === OTHER ? undefined : { title: SECTION_LABELS.folders, text: rootSummary(value) },
    });

    if (reply === BACK) {
      return BACK;
    }

    const root = reply === OTHER ? await typedFolder() : reply;

    if (root === BACK) {
      return editFolders(state, step);
    }

    if (reply === OTHER) {
      noteOf(
        io,
        io.plain
          ? [`${SECTION_LABELS.folders}: ${rootSummary(root)}`, ""]
          : [SECTION_LABELS.folders, rootSummary(root), ""],
        io.plain ? "rail" : "step",
      );
    }

    return touchedWith(state, "folders", { ...state.answers, root });
  };

  const customSize = async (size: VmSpec, index: number): Promise<Reply<VmSpec>> => {
    const key = VM_KEYS[index];

    if (key === undefined) {
      return size;
    }

    const bounds = vmBounds(facts);
    const field = numberFields(facts, bounds)[key];
    const last = index === VM_KEYS.length - 1;
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

  const hubSummary = (state: State, plan: Plan, notice: string | undefined, table: boolean) => {
    const summary = review.lines(state, plan, { plain: io.plain, table, notice });

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
      { value: "folders", label: "Change project folder" },
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
    const start: State = { answers: initialAnswers(document, facts, env), touched: new Set() };
    const steps = firstRunSteps(document);
    const stepped = await runSteps(start, steps, 0);

    return stepped === "leave" ? { kind: "cancelled" } : hub(stepped, undefined, steps.length === 0);
  };

  return { run };
};

const runWizard = (io: SetupIo, context: WizardContext): Promise<Outcome> => createWizard(io, context).run();

const invalidScreen = (io: SetupIo, input: SetupInput, read: Extract<DocumentRead, { ok: false }>) => {
  const { lines, end } = invalidLines(read, input.configFile, input.home);

  noteOf(io, [...lines, ""]);

  noteOf(io, [end], "end");

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

  return applyPlan(wizardFrontEnd(io, facts), effects, document, outcome);
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
