import type { ThemeLike, ThemeToken } from "../../../../core/adapter/contract.ts";
import { type AgentRecord, isClosed } from "../model/types.ts";
import {
  elapsedOf,
  formatDuration,
  formatTokens,
  innerWidth,
  PAD,
  padEndCols,
  SEP,
  singleLine,
} from "./format.ts";
import { stateGlyph, stateToken, stateWord } from "./state-text.ts";
import type { TreeRow } from "./tree.ts";

const NAME_COLS_MAX = 24;

const DESCRIPTION_COLS_MAX = 48;

const MIN_DESCRIPTION = 12;

const MIN_ROOM = 8;

const STATS_COLS = 30;

const POINTER_COLS = 2;

export type RowInput = TreeRow & { selected: boolean };

export type RowLayout = { nameCols: number; infoAt: number };

type NamedRow = Pick<TreeRow, "record" | "openDescendants">;

export const agentName = (record: AgentRecord): string =>
  record.chainIndex > 1 ? `${record.agent} #${record.chainIndex}` : record.agent;

const countSuffix = (openDescendants: number) => (openDescendants > 0 ? ` (+${openDescendants})` : "");

const rowName = (row: NamedRow): string => agentName(row.record) + countSuffix(row.openDescendants);

const nameColumn = (rows: NamedRow[], theme: ThemeLike): number =>
  Math.min(
    NAME_COLS_MAX,
    rows.reduce((widest, row) => Math.max(widest, theme.width(rowName(row))), 0),
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

  if (record.state === "grace" || record.state === "queued") {
    return [plainStats(stateWord(record.state), stateToken(record.state))];
  }

  const tokens = record.tokens > 0 ? `↓ ${formatTokens(record.tokens)} tokens` : undefined;

  return [join([record.activity, elapsed, tokens]), join([elapsed, tokens]), elapsed, ""].map((text) =>
    plainStats(text, "dim"),
  );
};

const roomFor = (theme: ThemeLike, width: number, fixed: number, stats: string) =>
  innerWidth(width) - fixed - (stats ? 2 + theme.width(stats) : 0);

const pickStats = (theme: ThemeLike, variants: Stats[], width: number, infoAt: number) =>
  variants.find((stats) => !stats.plain || infoAt + 2 + theme.width(stats.plain) <= innerWidth(width)) ??
  (variants.at(-1) as Stats);

const statsReserve = (theme: ThemeLike, record: AgentRecord, now: number) =>
  record.state === "running" ? STATS_COLS : theme.width((statsVariants(record, now)[0] as Stats).plain);

const paintName = (input: RowInput, cols: number, theme: ThemeLike) => {
  const base = agentName(input.record);
  const suffix = countSuffix(input.openDescendants);
  const token = isClosed(input.record.state) ? "muted" : "text";
  const cut = theme.truncate(base + suffix, cols);
  const painted =
    cut === base + suffix
      ? theme.fg(token, base) + (suffix ? theme.fg("dim", suffix) : "")
      : theme.fg(token, cut);

  return painted + " ".repeat(Math.max(0, cols - theme.width(cut)));
};

const leadOf = (theme: ThemeLike, row: TreeRow, nameCols: number, pointerCols: number) =>
  pointerCols + theme.width(treePrefix(row)) + 2 + nameCols + 2;

export const rowLayout = (
  rows: TreeRow[],
  now: number,
  width: number,
  selecting: boolean,
  theme: ThemeLike,
): RowLayout => {
  const nameCols = nameColumn(rows, theme);
  const reserve = selecting ? POINTER_COLS : 0;
  const widest = (measure: (row: TreeRow) => number) =>
    rows.reduce((most, row) => Math.max(most, measure(row)), 0);
  const wants = (row: TreeRow, cap: number) =>
    leadOf(theme, row, nameCols, 0) + Math.min(cap, theme.width(singleLine(row.record.description)));
  const wanted = widest((row) => wants(row, DESCRIPTION_COLS_MAX));
  const floor = widest((row) => wants(row, MIN_DESCRIPTION));
  const limit = innerWidth(width) - 2 - widest((row) => statsReserve(theme, row.record, now));
  const infoAt = Math.max(floor + reserve, Math.min(wanted + reserve, limit));

  return { nameCols, infoAt: Math.min(innerWidth(width), infoAt) };
};

export const renderRow = (
  input: RowInput,
  now: number,
  width: number,
  theme: ThemeLike,
  layout: RowLayout,
): string => {
  const { record } = input;
  const { nameCols, infoAt } = layout;
  const pointerCols = input.selected ? POINTER_COLS : 0;
  const pointer = input.selected ? `${theme.fg("accent", theme.bold("›"))} ` : "";
  const tree = treePrefix(input);
  const head = `${PAD}${pointer}${tree ? theme.fg("dim", tree) : ""}${theme.fg(stateToken(record.state), stateGlyph(record.state, now))} `;
  const fixed = leadOf(theme, input, nameCols, pointerCols);
  const stats = pickStats(theme, statsVariants(record, now), width, infoAt);
  const room = roomFor(theme, width, fixed, stats.plain);
  const tail = stats.plain ? `  ${stats.paint(theme)}` : "";

  if (room < MIN_ROOM) {
    const after = innerWidth(width) - pointerCols - theme.width(tree) - 2;

    if (stats.plain && 2 + theme.width(stats.plain) > after) {
      const cut = theme.truncate(stats.plain, Math.max(0, after - 2));

      return `${head}  ${theme.fg(stats.token, cut)}`;
    }

    const nameRoom = after - (stats.plain ? 2 + theme.width(stats.plain) : 0);

    return head + paintName(input, Math.max(0, nameRoom), theme) + tail;
  }

  const cols = Math.max(0, Math.min(room, stats.plain ? infoAt - fixed : DESCRIPTION_COLS_MAX));
  const description = theme.truncate(singleLine(record.description), cols);
  const shown = stats.plain ? padEndCols(theme, description, cols) : description;
  const padding = shown.slice(description.length);

  return `${head}${paintName(input, nameCols, theme)}  ${theme.fg("muted", description)}${padding}${tail}`;
};
