import type { VmPhase } from "../../backend/index.ts";
import { errorMessage, LauncherError } from "../../shared/index.ts";
import { elapsedOf } from "../prompt/style.ts";
import { Cancelled, type NotePlace, type Timers } from "../prompt/types.ts";
import type { Steps } from "../steps.ts";
import { tildeForm } from "./folders.ts";
import { isPlanEmpty } from "./plan.ts";
import {
  eventLines,
  type Paragraph,
  progressText,
  VM_FAILURE_CHOICES,
  vmInterruptWarning,
  wrapped,
} from "./screens.ts";
import type {
  Answers,
  ApplyEffects,
  ApplyEvent,
  ApplyFrontEnd,
  ConfigDocument,
  HostFacts,
  Plan,
  RunningVm,
  SetupIo,
  VmFailure,
} from "./types.ts";

const VM_TITLE = "Sandbox VM";

const PROBLEMS = new Set<ApplyEvent["kind"]>([
  "save-failed",
  "nothing-changed",
  "vm-unknown",
  "vm-failed",
  "vm-not-ready",
]);

const VM_SECTION = new Set<ApplyEvent["kind"]>(["vm-unknown", "vm-stopped", "vm-deferred", "vm-done"]);

export const noteOf = (io: SetupIo, paragraphs: Paragraph[], place: NotePlace = "rail") => {
  io.prompts.note((room) => wrapped(paragraphs, room), place);
};

const sectionNote = (io: SetupIo, lines: Paragraph[]) => {
  if (io.plain) {
    noteOf(io, lines);

    return;
  }

  noteOf(io, [VM_TITLE, ...lines, ""], "step");
};

const reasonOf = (error: unknown, prefix = "") => {
  const full = errorMessage(error);
  const message = full.startsWith(prefix) ? full.slice(prefix.length) : full;
  const hint = error instanceof LauncherError && error.hint !== undefined ? `; ${error.hint}` : "";

  return `${message}${hint}`;
};

const drawEvent = (io: SetupIo, facts: HostFacts) => (event: ApplyEvent) => {
  const lines = eventLines(event, facts, io.plain);

  if (VM_SECTION.has(event.kind)) {
    sectionNote(io, lines);

    return;
  }

  if (event.kind === "saved") {
    noteOf(io, [...lines, ...(io.plain ? [] : [""])]);

    return;
  }

  if (event.kind === "save-failed") {
    noteOf(io, [...lines, ""]);

    return;
  }

  noteOf(io, lines, "end");
};

const failedChoice = async (io: SetupIo, facts: HostFacts, failure: VmFailure) => {
  const lines = eventLines(failure, facts, io.plain);

  try {
    const choice = await io.prompts.select({
      title: VM_TITLE,
      detail: (room) => wrapped(lines, room),
      choices: [
        { value: "retry", label: VM_FAILURE_CHOICES.retry },
        { value: "exit", label: VM_FAILURE_CHOICES.exit },
      ],
      escape: "exit",
      interrupt: "exit",
      collapsed: () => undefined,
    });

    return choice === "retry";
  } catch (failure) {
    if (failure instanceof Cancelled) {
      return false;
    }

    throw failure;
  }
};

export const wizardFrontEnd = (io: SetupIo, facts: HostFacts): ApplyFrontEnd => ({
  now: io.now,
  report: drawEvent(io, facts),
  task: (spec) => io.prompts.task({ title: VM_TITLE, ...spec }),
  retry: (failure) => failedChoice(io, facts, failure),
});

const QUIET_EVENTS = new Set<ApplyEvent["kind"]>(["nothing-to-do", "nothing-changed", "done"]);

const textOf = (paragraph: Paragraph) => (typeof paragraph === "string" ? paragraph : paragraph.text);

export const stepsFrontEnd = (steps: Steps, facts: HostFacts, timers: Timers): ApplyFrontEnd => {
  const report = (event: ApplyEvent) => {
    if (QUIET_EVENTS.has(event.kind)) {
      return;
    }

    if (event.kind === "saved") {
      steps.done(`Wrote the settings (${tildeForm(facts.configFile, facts.home)})`);

      return;
    }

    if (event.kind === "vm-done" && event.applied === "created") {
      steps.done(`Created the sandbox VM in ${event.elapsed}`);

      return;
    }

    if (event.kind === "vm-done" && event.applied === "restarted") {
      steps.done(`Restarted the sandbox VM in ${event.elapsed}`);

      return;
    }

    const [first = "", ...rest] = eventLines(event, facts, true).map(textOf);

    if (first.startsWith("▲ ")) {
      steps.warn(first.slice(2));

      rest.forEach(steps.note);

      return;
    }

    if (PROBLEMS.has(event.kind)) {
      steps.failed(first.replace(/^✖ /, ""), rest.map((line) => line.trimStart()).join("\n"));

      return;
    }

    [first, ...rest].forEach(steps.note);
  };

  return {
    now: timers.now,
    report,
    task: (spec) => steps.task({ pending: "Preparing the sandbox VM" }, spec.run),
    retry: async (failure, error) => {
      if (!(error instanceof LauncherError)) {
        throw error;
      }

      report(failure);

      return false;
    },
  };
};

const savePlan = async (
  front: ApplyFrontEnd,
  effects: ApplyEffects,
  document: ConfigDocument,
  plan: Plan,
) => {
  try {
    await effects.write(document, plan.text);
  } catch (error) {
    front.report({ kind: "save-failed", reason: reasonOf(error, `could not save ${document.file}: `) });

    front.report({ kind: "nothing-changed" });

    return false;
  }

  front.report({ kind: "saved" });

  return true;
};

const runVm = async (
  front: ApplyFrontEnd,
  effects: ApplyEffects,
  action: RunningVm,
): Promise<number | boolean> => {
  const started = front.now();
  const seen: { phase?: VmPhase } = {};
  const progress = (update: (text: string) => void) => (phase: VmPhase) => {
    seen.phase = phase;

    update(progressText(phase, action));
  };

  try {
    const applied = await front.task({
      interruptWarning: () => vmInterruptWarning(seen.phase),
      run: (update) => effects.vm(action, progress(update)),
    });

    front.report({ kind: "vm-done", applied, action, elapsed: elapsedOf(front.now() - started) });

    return typeof applied !== "object";
  } catch (error) {
    if (error instanceof Cancelled) {
      front.report({ kind: "vm-cancelled", phase: seen.phase });

      return 130;
    }

    const failure: VmFailure = {
      kind: "vm-failed",
      action,
      elapsed: elapsedOf(front.now() - started),
      reason: reasonOf(error),
    };

    if (await front.retry(failure, error)) {
      return runVm(front, effects, action);
    }

    front.report({ kind: "vm-not-ready" });

    return 1;
  }
};

const applyVm = async (front: ApplyFrontEnd, effects: ApplyEffects, plan: Plan) => {
  const action = plan.vm;

  if (action.kind === "create" || action.kind === "restart") {
    return runVm(front, effects, action);
  }

  if (action.kind === "unknown") {
    front.report({ kind: "vm-unknown", reason: action.reason });
  }

  if (action.kind === "on-next-start") {
    front.report({ kind: "vm-stopped" });
  }

  if (action.kind === "defer") {
    front.report({ kind: "vm-deferred", sessions: action.sessions, parts: action.parts });
  }

  return action.kind !== "defer" && action.kind !== "unknown";
};

export const applyPlan = async (
  front: ApplyFrontEnd,
  effects: ApplyEffects,
  document: ConfigDocument,
  chosen: { plan: Plan; answers: Answers },
) => {
  if (isPlanEmpty(chosen.plan)) {
    front.report({ kind: "nothing-to-do" });

    return 0;
  }

  const saved = chosen.plan.changes.length === 0 || (await savePlan(front, effects, document, chosen.plan));

  if (!saved) {
    return 1;
  }

  const step = await applyVm(front, effects, chosen.plan);

  if (typeof step === "number") {
    return step;
  }

  front.report({ kind: "done", root: chosen.answers.root, vmReady: step });

  return 0;
};
