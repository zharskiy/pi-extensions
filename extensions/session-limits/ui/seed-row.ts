import { CHILD_COLUMN, type ThemeLike } from "../../../platform/pi-adapter/index.ts";
import { expandHint, type RowRender, row, wrapChild } from "../../../platform/ui-kit/index.ts";

const SEED_TITLE = "Handoff from the previous session";

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
      hint: expanded ? undefined : expandHint(expandKey),
      hintCuts: true,
    })(width, theme);
