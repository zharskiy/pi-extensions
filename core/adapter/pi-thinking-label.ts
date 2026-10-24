import type { Theme } from "@earendil-works/pi-coding-agent";
import { shared } from "./pi-shared.ts";

const ESC = String.fromCharCode(27);

const BEL = String.fromCharCode(7);

export const OSC133_ZONE_PREFIX = new RegExp(`^(?:${ESC}\\]133;[ABC](?:${BEL}|${ESC}\\\\))+`);

type LabelRecord = { label?: string; owner?: object };

const record = () => shared<LabelRecord>("thinking-label", () => ({}));

export const hiddenThinkingLabel = () => record().label;

export const storeLabel = (label: string | undefined, owner: object) => {
  const shared = record();

  shared.label = label;
  shared.owner = label === undefined ? undefined : owner;
};

export const releaseLabel = (owner: object) => {
  const shared = record();

  if (shared.owner !== owner) {
    return;
  }

  shared.label = undefined;
  shared.owner = undefined;
};

const RESET = "\x1b[0m";

export const composeLabel = (theme: Pick<Theme, "fg">, label: string, hint?: string) =>
  hint === undefined ? label : `${label} ${RESET}${theme.fg("dim", hint)}`;
