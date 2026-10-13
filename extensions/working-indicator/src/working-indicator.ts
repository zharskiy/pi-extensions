import type { Host, WorkingIndicator } from "../../../core/adapter/contract.ts";

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

export const workingMessage = (verb: string, elapsedMs: number, interruptKey: string) =>
  `${verb}… (${Math.floor(elapsedMs / 1000)}s · ${interruptKey} to interrupt)`;

export const createWorkingIndicator = (host: Host) => {
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    if (!timer) {
      return;
    }

    clearInterval(timer);
    timer = undefined;
    host.ui.setWorkingMessage(undefined);
  };

  const start = () => {
    stop();

    const startedAt = Date.now();
    const interruptKey = host.ui.keyText(INTERRUPT_BINDING);
    let verb = pickVerb();
    let nextVerbAt = VERB_MS;

    const tick = () => {
      const elapsedMs = Date.now() - startedAt;

      if (elapsedMs >= nextVerbAt) {
        verb = pickVerb();
        nextVerbAt = elapsedMs + VERB_MS;
      }

      host.ui.setWorkingMessage(workingMessage(verb, elapsedMs, interruptKey));
    };

    tick();
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  };

  host.onSessionStart(() => {
    host.ui.setWorkingIndicator(spinner);
  });

  host.onAgentStart(() => {
    if (host.session().mode !== "tui") {
      return;
    }

    start();
  });

  host.onIdle(() => {
    stop();
  });

  host.onSessionShutdown(() => {
    stop();
  });
};
