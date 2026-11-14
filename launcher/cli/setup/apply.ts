import { errorMessage, LauncherError } from "../../shared/index.ts";
import { elapsedOf } from "../prompt/style.ts";
import { BACK, Cancelled, type NotePlace } from "../prompt/types.ts";
import {
  deferredLines,
  type Paragraph,
  progressText,
  roomOf,
  STOPPED_VM,
  STOPPED_WAITING,
  savedLine,
  saveFailedLine,
  successLines,
  VM_FAILURE_CHOICES,
  VM_INTERRUPT_WARNING,
  VM_NOT_READY,
  vmDoneLine,
  vmFailureLines,
  vmUnknownLine,
  widthFor,
  wrapped,
} from "./screens.ts";
import type { Answers, ApplyEffects, ConfigDocument, HostFacts, Plan, SetupIo, VmAction } from "./types.ts";

type Running = Extract<VmAction, { kind: "create" | "restart" }>;

type VmStep = { deferred: boolean } | { exit: number };

const VM_TITLE = "Sandbox VM";

const SAVE_PREFIX = /^could not save [^:]*: /;

export const noteOf = (io: SetupIo, paragraphs: Paragraph[], place: NotePlace = "rail") => {
  const room = roomOf(widthFor(io.columns(), io.plain));

  io.prompts.note(wrapped(paragraphs, room), place);
};

const sectionNote = (io: SetupIo, lines: string[]) => {
  if (io.plain) {
    noteOf(io, lines);

    return;
  }

  noteOf(io, [VM_TITLE, ...lines.map((text) => ({ text, indent: "" })), ""], "step");
};

const reasonOf = (error: unknown) => {
  const message = errorMessage(error).replace(SAVE_PREFIX, "");
  const hint = error instanceof LauncherError && error.hint !== undefined ? `; ${error.hint}` : "";

  return `${message}${hint}`;
};

interface Target {
  document: ConfigDocument;
  facts: HostFacts;
}

const savePlan = async (io: SetupIo, effects: ApplyEffects, target: Target, plan: Plan) => {
  try {
    await effects.write(target.document, plan.text);
  } catch (error) {
    noteOf(io, [saveFailedLine(target.document.file, target.facts.home, reasonOf(error)), ""]);

    noteOf(io, ["Nothing was changed."], "end");

    return false;
  }

  noteOf(io, [savedLine(target.facts, io.plain), ...(io.plain ? [] : [""])]);

  return true;
};

const failedChoice = async (io: SetupIo, action: Running, elapsed: string, error: unknown) => {
  const room = roomOf(widthFor(io.columns(), io.plain));
  const detail = wrapped(
    vmFailureLines(action, elapsed, errorMessage(error)).map((text) => ({ text })),
    room,
  );

  try {
    const choice = await io.prompts.select({
      title: VM_TITLE,
      detail,
      choices: [
        { value: "retry", label: VM_FAILURE_CHOICES.retry },
        { value: "exit", label: VM_FAILURE_CHOICES.exit },
      ],
      escape: "exit",
      interrupt: "exit",
      collapsed: () => undefined,
    });

    return choice === BACK ? "exit" : choice;
  } catch (failure) {
    if (failure instanceof Cancelled) {
      return "exit";
    }

    throw failure;
  }
};

const runVm = async (io: SetupIo, effects: ApplyEffects, action: Running): Promise<VmStep> => {
  const started = io.now();

  try {
    const applied = await io.prompts.task({
      title: VM_TITLE,
      interruptWarning: VM_INTERRUPT_WARNING,
      run: (update) => effects.vm(action, (phase) => update(progressText(phase, action))),
    });

    sectionNote(io, [vmDoneLine(applied, action, elapsedOf(io.now() - started), io.plain)]);

    return { deferred: typeof applied === "object" };
  } catch (error) {
    if (error instanceof Cancelled) {
      noteOf(io, STOPPED_WAITING, "end");

      return { exit: 130 };
    }

    const choice = await failedChoice(io, action, elapsedOf(io.now() - started), error);

    if (choice === "retry") {
      return runVm(io, effects, action);
    }

    noteOf(io, [VM_NOT_READY], "end");

    return { exit: 1 };
  }
};

const applyVm = async (io: SetupIo, effects: ApplyEffects, action: VmAction): Promise<VmStep> => {
  if (action.kind === "create" || action.kind === "restart") {
    return runVm(io, effects, action);
  }

  if (action.kind === "unknown") {
    sectionNote(io, [vmUnknownLine(action.reason)]);
  }

  if (action.kind === "on-next-start") {
    sectionNote(io, [STOPPED_VM]);
  }

  if (action.kind === "defer") {
    sectionNote(io, deferredLines(action.sessions, action.parts));
  }

  return { deferred: action.kind === "defer" };
};

export const applyPlan = async (
  io: SetupIo,
  effects: ApplyEffects,
  target: Target,
  chosen: { plan: Plan; answers: Answers },
) => {
  const saved = chosen.plan.changes.length === 0 || (await savePlan(io, effects, target, chosen.plan));

  if (!saved) {
    return 1;
  }

  const step = await applyVm(io, effects, chosen.plan.vm);

  if ("exit" in step) {
    return step.exit;
  }

  noteOf(io, successLines(chosen.answers.roots, target.facts, step.deferred, io.plain), "end");

  return 0;
};
