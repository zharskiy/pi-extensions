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

const MODEL_COLS_MAX = 32;

const POINTER_COLS = 2;

export const POINTER_BLANK = " ".repeat(POINTER_COLS);

export type RowInput = TreeRow & { selected: boolean };

export type RowLayout = { nameCols: number; infoAt: number; modelCols: number };

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

const leadOf = (theme: ThemeLike, row: TreeRow, nameCols: number) =>
  POINTER_COLS + theme.width(treePrefix(row)) + 2 + nameCols + 2;

export type RowMeasure = {
  nameCols: number;
  wanted: number;
  floor: number;
  modelFloor: number;
  modelCols: number;
  reserve: number;
  live: AgentRecord[];
  records: AgentRecord[];
};

const WIDEST_TOKENS = 999_900;

const WIDEST_ELAPSED = 3_599_000;

const grows = (record: AgentRecord) => record.state === "running" || record.endedAt === undefined;

const widestStats = (theme: ThemeLike, record: AgentRecord) => {
  const probe = grows(record)
    ? { ...record, tokens: WIDEST_TOKENS, startedAt: 0, endedAt: WIDEST_ELAPSED }
    : record;

  return theme.width((statsVariants(probe, 0)[0] as Stats).plain);
};

const modelGapOf = (modelCols: number) => (modelCols > 0 ? 2 + modelCols : 0);

const hasFixedStats = (record: AgentRecord) => !isClosed(record.state) || record.endedAt !== undefined;

export const measureRows = (rows: TreeRow[], theme: ThemeLike): RowMeasure => {
  const nameCols = nameColumn(rows, theme);

  return rows.reduce<RowMeasure>(
    (measure, row) => {
      const lead = leadOf(theme, row, nameCols);
      const described = theme.width(singleLine(row.record.description));

      measure.wanted = Math.max(measure.wanted, lead + Math.min(DESCRIPTION_COLS_MAX, described));
      measure.floor = Math.max(measure.floor, lead + Math.min(MIN_DESCRIPTION, described));
      measure.modelFloor = Math.max(measure.modelFloor, lead + MIN_DESCRIPTION);
      measure.modelCols = Math.max(
        measure.modelCols,
        Math.min(MODEL_COLS_MAX, theme.width(row.record.model ?? "")),
      );

      measure.records.push(row.record);

      if (hasFixedStats(row.record)) {
        measure.reserve = Math.max(measure.reserve, statsReserve(theme, row.record, 0));
      } else {
        measure.live.push(row.record);
      }

      return measure;
    },
    { nameCols, wanted: 0, floor: 0, modelFloor: 0, modelCols: 0, reserve: 0, live: [], records: [] },
  );
};

export const layoutOf = (measure: RowMeasure, now: number, width: number, theme: ThemeLike): RowLayout => {
  const reserve = measure.live.reduce(
    (most, record) => Math.max(most, statsReserve(theme, record, now)),
    measure.reserve,
  );
  const modelGap = modelGapOf(measure.modelCols);
  const widest = measure.records.reduce(
    (most, record) => Math.max(most, widestStats(theme, record)),
    reserve,
  );
  const placeInfo = (gap: number) =>
    Math.max(measure.floor, Math.min(measure.wanted, innerWidth(width) - 2 - reserve - gap));
  const fitsModel =
    modelGap > 0 &&
    measure.modelFloor <= innerWidth(width) - 2 - reserve - modelGap &&
    placeInfo(modelGap) + modelGap + 2 + widest <= innerWidth(width);
  const infoAt = placeInfo(fitsModel ? modelGap : 0);

  return {
    nameCols: measure.nameCols,
    infoAt: Math.min(innerWidth(width), infoAt),
    modelCols: fitsModel ? measure.modelCols : 0,
  };
};

export const rowLayout = (rows: TreeRow[], now: number, width: number, theme: ThemeLike): RowLayout =>
  layoutOf(measureRows(rows, theme), now, width, theme);

const modelCell = (theme: ThemeLike, label: string, cols: number) =>
  (label ? theme.fg("dim", label) : "") + " ".repeat(Math.max(0, cols - theme.width(label)));

export const renderRow = (
  input: RowInput,
  now: number,
  width: number,
  theme: ThemeLike,
  layout: RowLayout,
): string => {
  const { record } = input;
  const { nameCols, infoAt, modelCols } = layout;
  const modelGap = modelGapOf(modelCols);
  const pointer = input.selected ? `${theme.fg("accent", theme.bold("›"))} ` : POINTER_BLANK;
  const tree = treePrefix(input);
  const head = `${PAD}${pointer}${tree ? theme.fg("dim", tree) : ""}${theme.fg(stateToken(record.state), stateGlyph(record.state, now))} `;
  const fixed = leadOf(theme, input, nameCols);
  const stats = pickStats(theme, statsVariants(record, now), width, infoAt + modelGap);
  const room = roomFor(theme, width, fixed + modelGap, stats.plain);
  const tail = stats.plain ? `  ${stats.paint(theme)}` : "";

  if (room < MIN_ROOM) {
    const after = innerWidth(width) - POINTER_COLS - theme.width(tree) - 2;

    if (stats.plain && 2 + theme.width(stats.plain) > after) {
      const cut = theme.truncate(stats.plain, Math.max(0, after - 2));

      return `${head}  ${theme.fg(stats.token, cut)}`;
    }

    const nameRoom = after - (stats.plain ? 2 + theme.width(stats.plain) : 0);

    return head + paintName(input, Math.max(0, nameRoom), theme) + tail;
  }

  const label = modelGap > 0 ? theme.truncate(record.model ?? "", modelCols) : "";
  const followed = stats.plain !== "" || label !== "";
  const cols = Math.max(0, Math.min(room, followed ? infoAt - fixed : DESCRIPTION_COLS_MAX));
  const description = theme.truncate(singleLine(record.description), cols);
  const shown = followed ? padEndCols(theme, description, cols) : description;
  const padding = shown.slice(description.length);
  const model = modelGap > 0 && followed ? `  ${modelCell(theme, label, stats.plain ? modelCols : 0)}` : "";

  return `${head}${paintName(input, nameCols, theme)}  ${theme.fg("muted", description)}${padding}${model}${tail}`;
};
