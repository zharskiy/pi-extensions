import { type EntryRender, labelledRule, type ThemeLike } from "../../../platform/pi-adapter/index.ts";
import { counted, DOT } from "../../../platform/shared/index.ts";
import { HANDOFF_COMMAND } from "../core/handoff.ts";
import { type KeptRule, parseKeptMessage, parseKeptRule } from "../core/kept-entries.ts";

const KEPT_LABEL = "handing off, messages below go to the new session";

const EDITOR_LABEL = `${KEPT_LABEL}'s editor`;

const SWITCH_HINT = `${DOT}/${HANDOFF_COMMAND} switches now`;

const RULE_LABELS: Record<KeptRule["state"], string> = {
  kept: KEPT_LABEL,
  waiting: `${KEPT_LABEL}${SWITCH_HINT}`,
  editor: EDITOR_LABEL,
  "editor-waiting": `${EDITOR_LABEL}${SWITCH_HINT}`,
  returned: "handoff abandoned, messages are back in the editor",
};

export const keptRule: EntryRender = (data, width, _expanded, theme) => {
  const rule = parseKeptRule(data);

  return rule ? [labelledRule(theme, width, RULE_LABELS[rule.state])] : [];
};

const bubbleLine = (theme: ThemeLike, width: number, pad: number) => (line: string) => {
  const gap = Math.max(0, width - pad - theme.width(line));

  return theme.bg("userMessage", `${" ".repeat(pad)}${line}${" ".repeat(gap)}`);
};

export const keptMessage: EntryRender = (data, width, _expanded, theme, pad) => {
  const message = parseKeptMessage(data);

  if (!message) {
    return [];
  }

  const inner = Math.max(1, width - pad * 2);
  const body = message.text.trim()
    ? theme.wrap(message.text, inner).map((line) => theme.fg("userMessageText", line))
    : [];
  const note = message.images > 0 ? [theme.fg("muted", counted(message.images, "image"))] : [];

  return ["", ...body, ...note, ""].map(bubbleLine(theme, width, pad));
};
