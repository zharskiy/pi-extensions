import type { Host, Phase } from "../../../core/adapter/contract.ts";
import { formatDuration } from "../../../core/manager/format.ts";
import { DOT, ELLIPSIS } from "../../../core/manager/layout.ts";

export const TICK_MS = 1000;

export const VERB_MS = 8000;

export const VERBS = [
  "Frolicking",
  "Metamorphosing",
  "Misting",
  "Moonwalking",
  "Moseying",
  "Mulling",
  "Musing",
  "Nebulizing",
  "Nesting",
  "Newspapering",
  "Noodling",
  "Nucleating",
  "Orbiting",
  "Orchestrating",
  "Osmosing",
  "Perambulating",
  "Percolating",
  "Perusing",
  "Philosophising",
  "Photosynthesizing",
  "Pollinating",
  "Pondering",
  "Pontificating",
  "Pouncing",
  "Precipitating",
  "Prestidigitating",
  "Proofing",
  "Propagating",
  "Puttering",
  "Puzzling",
  "Quantumizing",
  "Razzle-dazzling",
  "Razzmatazzing",
  "Recombobulating",
  "Reticulating",
  "Roosting",
  "Ruminating",
  "Sautéing",
  "Scampering",
  "Schlepping",
  "Scurrying",
  "Seasoning",
  "Shenaniganing",
  "Shimmying",
  "Simmering",
  "Skedaddling",
  "Sketching",
  "Slithering",
  "Smooshing",
  "Sock-hopping",
  "Spelunking",
  "Sprouting",
  "Stewing",
  "Sublimating",
  "Swirling",
  "Swooping",
  "Symbioting",
  "Synthesizing",
];

const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)] ?? "Working";

const INTERRUPT_BINDING = "app.interrupt";

const workingText = (verb: string, elapsedMs: number, hint: string) => {
  const elapsed = elapsedMs >= TICK_MS ? `${DOT}${formatDuration(elapsedMs)}` : "";

  return `${verb}${ELLIPSIS}${elapsed}${hint}`;
};

type Run = {
  startedAt: number;
  hint: string;
  verb: string;
  nextVerbAt: number;
  timer: ReturnType<typeof setInterval>;
};

export const createWorkingIndicator = (host: Host) => {
  let run: Run | undefined;
  let hidden = false;
  let written: string | undefined;

  const write = (active: Run) => {
    const text = workingText(active.verb, Date.now() - active.startedAt, active.hint);

    if (text === written) {
      return;
    }

    written = text;
    host.ui.setWorkingMessage(text);
  };

  const tick = () => {
    if (!run) {
      return;
    }

    const elapsedMs = Date.now() - run.startedAt;

    if (elapsedMs >= run.nextVerbAt) {
      run.verb = pickVerb();
      run.nextVerbAt = elapsedMs + VERB_MS;
    }

    write(run);
  };

  const applyVisibility = (next: Phase) => {
    const visible = next !== "writing";

    if (visible === !hidden) {
      return;
    }

    host.ui.setWorkingVisible(visible);
    hidden = !visible;
  };

  const begin = () => {
    const timer = setInterval(tick, TICK_MS);
    const key = host.ui.keyText(INTERRUPT_BINDING);

    timer.unref?.();
    run = {
      startedAt: Date.now(),
      hint: key ? host.ui.style("dim", ` (${key} to interrupt)`) : "",
      verb: pickVerb(),
      nextVerbAt: VERB_MS,
      timer,
    };

    write(run);
  };

  const stop = () => {
    if (!run) {
      return;
    }

    clearInterval(run.timer);
    run = undefined;
    written = undefined;
    host.ui.setWorkingMessage(undefined);
  };

  const end = () => {
    applyVisibility("idle");
    stop();
  };

  host.onAgentStart(() => {
    if (host.session().mode !== "tui" || run) {
      return;
    }

    begin();
  });

  host.onPhase((next) => {
    if (next === "idle") {
      end();
      return;
    }

    if (!run) {
      return;
    }

    applyVisibility(next);
  });

  host.onSessionShutdown(() => {
    stop();
  });
};
