import { DOT, formatDuration } from "../../../platform/shared/index.ts";
import { keyHintText } from "../../../platform/ui-kit/index.ts";
import { TICK_MS } from "../core/indicator-state.ts";

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

export const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)] ?? "Working";

export const workingText = (verb: string, elapsedMs: number, hint: string) => {
  const duration = elapsedMs >= TICK_MS ? formatDuration(elapsedMs) : "";
  const elapsed = duration === "" ? "" : `${DOT}${duration}`;

  return `${verb}${elapsed}${hint}`;
};

export const interruptHint = (key: string | undefined, dim: (text: string) => string) => {
  const hint = keyHintText(key, "interrupt");

  return hint ? dim(` ${hint}`) : "";
};
