import { homedir } from "node:os";
import { CHILD_COLUMN, type MessageRender, type ThemeLike } from "../pi-adapter/index.ts";
import {
  DOT,
  formatWindow,
  type HandoffToolRows,
  homeRelative,
  parseRequestDetails,
  parseSeedDetails,
} from "../shared/index.ts";
import { markOf } from "./glyphs.ts";
import { EXPAND_BINDING, expandHint } from "./key-hints.ts";
import { type RowRender, row, rowChildren, rowText, wrapChild } from "./row.ts";

const SEED_TITLE = "handoff";

const SESSION_SEED_TITLE = "handoff from the previous session";

export const firstSentence = (text: string) => {
  const [line = ""] = text.trim().split("\n");
  const end = /[.!?](\s|$)/.exec(line);

  return end ? line.slice(0, end.index + 1) : line;
};

const seedTitle = (details: unknown) => {
  const source = parseSeedDetails(details);

  if (source?.from === "agent") {
    return `handoff from agent ${source.id}${DOT}link ${source.link}`;
  }

  return source ? SESSION_SEED_TITLE : SEED_TITLE;
};

const summary = (text: string) => (theme: ThemeLike) => theme.fg("muted", firstSentence(text));

const seedRow =
  (title: string, text: string, expanded: boolean, expandKey: string): RowRender =>
  (width, theme) =>
    row({
      mark: "info",
      title: theme.bold(title),
      children: expanded ? [wrapChild(text.trim(), width, CHILD_COLUMN, theme).join("\n")] : [summary(text)],
      hint: expanded ? undefined : expandHint(expandKey),
      hintCuts: true,
    })(width, theme);

export const handoffSeedMessage =
  (keyText: (binding: string) => string): MessageRender =>
  (message, width, expanded, theme) =>
    seedRow(seedTitle(message.details), message.text, expanded, keyText(EXPAND_BINDING))(width, theme);

const REQUEST_TITLE = "handoff requested";

const requestTitle = (details: unknown) => {
  const known = parseRequestDetails(details);

  if (known?.reason === "manual") {
    return `${REQUEST_TITLE}${DOT}${known.command}`;
  }

  return known?.tokens !== undefined && known.request !== undefined
    ? `${REQUEST_TITLE}${DOT}${formatWindow(known.tokens)} of ${formatWindow(known.request)} tokens`
    : REQUEST_TITLE;
};

export const handoffRequestMessage =
  (keyText: (binding: string) => string): MessageRender =>
  (message, width, expanded, theme) =>
    row({
      mark: "info",
      title: theme.bold(requestTitle(message.details)),
      children: expanded ? [wrapChild(message.text.trim(), width, CHILD_COLUMN, theme).join("\n")] : [],
      hint: expanded ? undefined : expandHint(keyText(EXPAND_BINDING)),
      hintCuts: true,
    })(width, theme);

export const handoffToolRows = (savedPath: () => string | undefined): HandoffToolRows => ({
  renderCall: (_params, theme, state) =>
    rowText(row({ mark: markOf(state), title: { verb: (paint) => paint.bold("handoff") } }), theme),
  renderResult: (result, _state, theme) => {
    if (result.isError) {
      const lines = result.text.split("\n");

      return rowText(rowChildren({ children: lines.map((line) => theme.fg("error", line)) }), theme);
    }

    const path = savedPath();
    const saved = path ? `Saved ${homeRelative(path, homedir())}` : result.text;

    return rowText(rowChildren({ children: [theme.fg("muted", saved)] }), theme);
  },
});
