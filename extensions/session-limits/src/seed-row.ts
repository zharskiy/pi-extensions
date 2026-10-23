import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { CHILD_INDENT, expandHint, type RowRender, toolRow } from "../../../core/manager/row.ts";

export const SEED_TITLE = "Handoff from previous session";

export const firstSentence = (text: string) => {
  const [line = ""] = text.trim().split("\n");
  const end = /[.!?](\s|$)/.exec(line);

  return end ? line.slice(0, end.index + 1) : line;
};

const wrapped = (text: string, width: number, theme: ThemeLike) =>
  text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : theme.wrap(line, Math.max(1, width - CHILD_INDENT.length))));

export const seedRow =
  (text: string, expanded: boolean, expandKey: string): RowRender =>
  (width, theme) =>
    toolRow({
      state: "success",
      title: SEED_TITLE,
      children: expanded ? wrapped(text.trim(), width, theme) : [firstSentence(text)],
      hint: expanded ? undefined : (paint) => expandHint(expandKey, paint),
    })(width, theme);
