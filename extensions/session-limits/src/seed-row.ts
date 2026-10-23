import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { CHILD_COLUMN, expandHintFor, type RowRender, row, wrapChild } from "../../../core/manager/row.ts";

export const SEED_TITLE = "Handoff from the previous session";

export const firstSentence = (text: string) => {
  const [line = ""] = text.trim().split("\n");
  const end = /[.!?](\s|$)/.exec(line);

  return end ? line.slice(0, end.index + 1) : line;
};

const summary = (text: string) => (theme: ThemeLike) => theme.fg("muted", firstSentence(text));

export const seedRow =
  (text: string, expanded: boolean, expandKey: string): RowRender =>
  (width, theme) =>
    row({
      mark: "info",
      title: theme.bold(SEED_TITLE),
      children: expanded ? [wrapChild(text.trim(), width, CHILD_COLUMN, theme).join("\n")] : [summary(text)],
      hint: expanded ? undefined : expandHintFor(expandKey),
      hintCuts: true,
    })(width, theme);
