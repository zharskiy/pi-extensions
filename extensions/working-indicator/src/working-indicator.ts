import type { Host, Phase, WorkingIndicator } from "../../../core/adapter/contract.ts";
import { formatDuration } from "../../../core/manager/format.ts";

const SPINNER: keyof typeof SPINNERS = "braille";

export const VERB_MS = 8000;

export const TICK_MS = 1000;

const INTERRUPT_BINDING = "app.interrupt";

const SPINNERS = {
  braille: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
  dots: { frames: ["∴", "∷", "∵", "∷"], intervalMs: 200 },
  bar: { frames: ["·|·", "·/·", "·—·", "·\\·"], intervalMs: 200 },
  mark: { frames: ["✻"], intervalMs: 500 },
} satisfies Record<string, WorkingIndicator>;

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

export const workingMessage = (verb: string, elapsedMs: number, interruptKey: string, toolName?: string) =>
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
  let phase: Phase = "idle";
  let toolName: string | undefined;
  let hidden = false;

  const message = (active: Run) =>
    workingMessage(active.verb, Date.now() - active.startedAt, active.interruptKey, toolName);

  const write = () => {
    if (!run) {
      return;
    }

    host.ui.setWorkingMessage(message(run));
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

    write();
  };

  const applyVisibility = () => {
    const visible = phase !== "writing";

    if (visible === !hidden) {
      return;
    }

    host.ui.setWorkingVisible(visible);
    hidden = !visible;
  };

  const begin = () => {
    const current = host.phase();

    phase = current.phase === "idle" ? "waiting" : current.phase;
    toolName = phase === "tool" ? current.detail.toolName : undefined;

    const timer = setInterval(tick, TICK_MS);

    timer.unref?.();

    run = {
      startedAt: Date.now(),
      interruptKey: host.ui.keyText(INTERRUPT_BINDING),
      verb: pickVerb(),
      nextVerbAt: VERB_MS,
      timer,
    };

    write();
  };

  const stop = () => {
    if (!run) {
      return;
    }

    clearInterval(run.timer);
    run = undefined;
    host.ui.setWorkingMessage(undefined);
  };

  const end = () => {
    if (hidden) {
      host.ui.setWorkingVisible(true);
      hidden = false;
    }

    stop();
    phase = "idle";
    toolName = undefined;
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

    const nextTool = next === "tool" ? detail.toolName : undefined;

    if (next === phase && nextTool === toolName) {
      return;
    }

    phase = next;
    toolName = nextTool;
    write();
    applyVisibility();
  });

  host.onSessionShutdown(() => {
    stop();
  });
};
