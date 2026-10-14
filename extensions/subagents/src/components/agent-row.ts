import type { ThemeLike, ThemeToken } from "../../../../core/adapter/contract.ts";
import { type AgentRecord, isClosed } from "../model/types.ts";
import {
  displayWidth,
  elapsedOf,
  formatDuration,
  formatTokens,
  innerWidth,
  PAD,
  padEndCols,
  SEP,
  singleLine,
  truncateCols,
} from "./format.ts";
import { stateGlyph, stateToken, stateWord } from "./state-text.ts";
import type { TreeRow } from "./tree.ts";

export const NAME_COLS_MAX = 24;

const MIN_DESCRIPTION = 12;

const MIN_ROOM = 8;

export type RowInput = TreeRow & { selected: boolean };

type NamedRow = Pick<TreeRow, "record" | "openDescendants">;

const baseName = (record: AgentRecord) =>
  record.chainIndex > 1 ? `${record.agent} #${record.chainIndex}` : record.agent;

const countSuffix = (openDescendants: number) => (openDescendants > 0 ? ` (+${openDescendants})` : "");

export const rowName = (row: NamedRow): string => baseName(row.record) + countSuffix(row.openDescendants);

export const nameColumn = (rows: NamedRow[]): number =>
  Math.min(
    NAME_COLS_MAX,
    rows.reduce((widest, row) => Math.max(widest, displayWidth(rowName(row))), 0),
  );

const treePrefix = (row: Pick<TreeRow, "depth" | "last" | "ancestorsContinue">) =>
  row.depth === 0
    ? ""
    : row.ancestorsContinue.map((more) => (more ? "│  " : "   ")).join("") + (row.last ? "└─ " : "├─ ");

type Stats = { plain: string; token: ThemeToken; paint(theme: ThemeLike): string };

const plainStats = (text: string, token: ThemeToken): Stats => ({
  plain: text,
  token,
  paint: (theme) => (text ? theme.fg(token, text) : ""),
});

const join = (parts: (string | undefined)[]) => parts.filter((part) => part !== undefined).join(SEP);

const statsVariants = (record: AgentRecord, now: number): Stats[] => {
  const elapsed = formatDuration(elapsedOf(record, now));

  if (isClosed(record.state)) {
    const word = stateWord(record.state);

    return [
      {
        plain: word + SEP + elapsed,
        token: stateToken(record.state),
        paint: (theme) =>
          theme.fg(stateToken(record.state), word) + theme.fg("dim", SEP) + theme.fg("dim", elapsed),
      },
      plainStats(word, stateToken(record.state)),
    ];
  }

  if (record.state === "grace") {
    return [plainStats("stopping", "warning")];
  }

  if (record.state === "queued") {
    return [plainStats("queued", "muted")];
  }

  const activity = record.activity
    ? record.activity.kind === "tool"
      ? record.activity.text
      : "writing"
    : undefined;
  const tokens = record.tokens > 0 ? `↓ ${formatTokens(record.tokens)} tokens` : undefined;

  return [join([activity, elapsed, tokens]), join([elapsed, tokens]), elapsed, ""].map((text) =>
    plainStats(text, "dim"),
  );
};

const roomFor = (width: number, fixed: number, stats: string) =>
  innerWidth(width) - fixed - (stats ? 2 + displayWidth(stats) : 0);

const pickStats = (variants: Stats[], width: number, fixed: number) => {
  const fitting = variants.find((stats) => roomFor(width, fixed, stats.plain) >= MIN_DESCRIPTION);
  const stats = fitting ?? (variants.at(-1) as Stats);

  return { stats, room: roomFor(width, fixed, stats.plain) };
};

const paintName = (input: RowInput, cols: number, theme: ThemeLike) => {
  const base = baseName(input.record);
  const suffix = countSuffix(input.openDescendants);
  const token = isClosed(input.record.state) ? "muted" : "text";
  const cut = truncateCols(base + suffix, cols);
  const painted =
    cut === base + suffix
      ? theme.fg(token, base) + (suffix ? theme.fg("dim", suffix) : "")
      : theme.fg(token, cut);

  return painted + " ".repeat(Math.max(0, cols - displayWidth(cut)));
};

export const POINTER_COLS = 2;

export const renderRow = (
  input: RowInput,
  now: number,
  width: number,
  theme: ThemeLike,
  nameCols: number,
): string => {
  const { record } = input;
  const pointerCols = input.selected ? POINTER_COLS : 0;
  const pointer = input.selected ? `${theme.fg("accent", theme.bold("›"))} ` : "";
  const tree = treePrefix(input);
  const head = `${PAD}${pointer}${tree ? theme.fg("dim", tree) : ""}${theme.fg(stateToken(record.state), stateGlyph(record.state, now))} `;
  const fixed = pointerCols + displayWidth(tree) + 2 + nameCols + 2;
  const { stats, room } = pickStats(statsVariants(record, now), width, fixed);
  const tail = stats.plain ? `  ${stats.paint(theme)}` : "";

  if (room < MIN_ROOM) {
    const after = innerWidth(width) - pointerCols - displayWidth(tree) - 2;

    if (stats.plain && 2 + displayWidth(stats.plain) > after) {
      const cut = truncateCols(stats.plain, Math.max(0, after - 2));

      return `${head}  ${theme.fg(stats.token, cut)}`;
    }

    const nameRoom = after - (stats.plain ? 2 + displayWidth(stats.plain) : 0);

    return head + paintName(input, Math.max(0, nameRoom), theme) + tail;
  }

  const description = truncateCols(singleLine(record.description), room);
  const shown = stats.plain ? padEndCols(description, room) : description;
  const padding = shown.slice(description.length);

  return `${head}${paintName(input, nameCols, theme)}  ${theme.fg("muted", description)}${padding}${tail}`;
};
