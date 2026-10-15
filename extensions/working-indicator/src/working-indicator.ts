import type { Host, Phase, WorkingIndicator } from "../../../core/adapter/contract.ts";
import { formatDuration } from "../../../core/manager/format.ts";

const SPINNER: keyof typeof SPINNERS = "braille";

export const VERB_MS = 8000;

export const TICK_MS = 1000;

const INTERRUPT_BINDING = "app.interrupt";

const SPINNERS = {
  braille: undefined,
  dots: { frames: ["∴", "∷", "∵", "∷"], intervalMs: 200 },
  bar: { frames: ["·|·", "·/·", "·—·", "·\\·"], intervalMs: 200 },
  mark: { frames: ["✻"], intervalMs: 500 },
} satisfies Record<string, WorkingIndicator | undefined>;

export const spinner = SPINNERS[SPINNER];

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

const workingMessage = (verb: string, elapsedMs: number, interruptKey: string, toolName?: string) =>
  `${verb}… (${toolName ? `${toolName} · ` : ""}${formatDuration(elapsedMs)} · ${interruptKey} to interrupt)`;

type Run = {
  startedAt: number;
  interruptKey: string;
  verb: string;
  nextVerbAt: number;
  timer: ReturnType<typeof setInterval>;
};

export const createWorkingIndicator = (host: Host) => {
  let run: Run | undefined;
  let toolName: string | undefined;
  let hidden = false;
  let written: string | undefined;

  const write = (active: Run) => {
    const text = workingMessage(active.verb, Date.now() - active.startedAt, active.interruptKey, toolName);

    if (text === written) {
      return;
    }

    written = text;
    host.ui.setWorkingMessage(text);
  };

  const tick = () => {
    const active = run;

    if (!active) {
      return;
    }

    const elapsedMs = Date.now() - active.startedAt;

    if (elapsedMs >= active.nextVerbAt) {
      active.verb = pickVerb();
      active.nextVerbAt = elapsedMs + VERB_MS;
    }

    write(active);
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

    timer.unref?.();
    toolName = undefined;
    run = {
      startedAt: Date.now(),
      interruptKey: host.ui.keyText(INTERRUPT_BINDING),
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
    toolName = undefined;
    applyVisibility("idle");
    stop();
  };

  host.onSessionStart(() => {
    host.ui.setWorkingIndicator(spinner);
  });

  host.onAgentStart(() => {
    if (host.session().mode !== "tui" || run) {
      return;
    }

    begin();
  });

  host.onPhase((next, detail) => {
    if (next === "idle") {
      end();
      return;
    }

    if (!run) {
      return;
    }

    toolName = next === "tool" ? detail.toolName : undefined;
    write(run);
    applyVisibility(next);
  });

  host.onSessionShutdown(() => {
    stop();
  });
};
