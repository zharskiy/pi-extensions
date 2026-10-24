import type { Phase } from "../../../platform/pi-adapter/index.ts";

export const TICK_MS = 1000;

export const VERB_MS = 8000;

export type Run = {
  startedAt: number;
  hint: string;
  verb: string;
  nextVerbAt: number;
  timer: ReturnType<typeof setInterval>;
};

export const startRun = (timer: Run["timer"], hint: string, verb: string): Run => ({
  startedAt: Date.now(),
  hint,
  verb,
  nextVerbAt: VERB_MS,
  timer,
});

export const elapsedOf = (run: Run) => Date.now() - run.startedAt;

export const rotateVerb = (run: Run, pickVerb: () => string) => {
  const elapsedMs = elapsedOf(run);

  if (elapsedMs >= run.nextVerbAt) {
    run.verb = pickVerb();
    run.nextVerbAt = elapsedMs + VERB_MS;
  }
};

export const isVisibleIn = (phase: Phase) => phase !== "writing";
