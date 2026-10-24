import { PAD, type ThemeLike } from "../../../../pi-adapter/index.ts";
import { pointerMark } from "../../../../ui-kit/index.ts";
import {
  agentReceipt,
  plainReceipt,
  type ReceiptSegment,
  singleLine,
} from "../../core/components/receipt.ts";
import { type AgentRecord, isClosed } from "../../core/model/agent-record.ts";
import { padEndCols, receiptText } from "./format.ts";
import { liveGlyph, scrollGlyph } from "./state-text.ts";
import { nestPrefix } from "./tree-glyphs.ts";

const NAME_COLS_MAX = 24;

const DESCRIPTION_COLS_MAX = 48;

const MIN_DESCRIPTION = 12;

const MODEL_COLS_MAX = 20;

const GAP = "  ";

const POINTER_COLS = 2;

const GLYPH_COLS = 2;

export const POINTER_BLANK = " ".repeat(POINTER_COLS);

type RowRecord = Pick<
  AgentRecord,
  | "agent"
  | "chainIndex"
  | "description"
  | "model"
  | "state"
  | "turns"
  | "toolCalls"
  | "tokens"
  | "cost"
  | "activity"
  | "createdAt"
  | "startedAt"
  | "endedAt"
>;

export type RowInput = {
  record: RowRecord;
  depth: number;
  first: boolean;
  openDescendants: number;
  selected?: boolean;
};

export type RowLayout = {
  nameCols: number;
  descriptionCols: number;
  modelCols: number;
  statusCols: number;
  now: number;
  spinner: boolean;
  bare: boolean;
};

type RowOptions = { spinner?: boolean; bare?: boolean };

export const chainSuffix = (chainIndex: number) => (chainIndex > 1 ? ` #${chainIndex}` : "");

export const agentName = (record: Pick<AgentRecord, "agent" | "chainIndex">): string =>
  record.agent + chainSuffix(record.chainIndex);

const countSuffix = (openDescendants: number) => (openDescendants > 0 ? ` (+${openDescendants})` : "");

const nameText = (input: RowInput) => agentName(input.record) + countSuffix(input.openDescendants);

export const modelId = (model: string): string => model.slice(model.indexOf("/") + 1);

export const modelLabel = (theme: ThemeLike, model: string, cols: number) => {
  const cut = model.lastIndexOf(":");
  const suffix = cut > 0 ? model.slice(cut) : "";
  const room = cols - theme.width(suffix);

  if (theme.width(model) <= cols || suffix === "" || room < 2) {
    return theme.truncate(model, cols);
  }

  return `${theme.truncate(model.slice(0, cut), room)}${suffix}`;
};

const statusOf = (record: RowRecord, now: number): ReceiptSegment[] =>
  agentReceipt(record, now, { live: true });

const plainWidth = (segments: ReceiptSegment[], theme: ThemeLike) => theme.width(plainReceipt(segments));

const widest = (values: number[]) => values.reduce((most, value) => Math.max(most, value), 0);

export const rowLayout = (
  rows: readonly RowInput[],
  now: number,
  width: number,
  theme: ThemeLike,
  options: RowOptions = {},
): RowLayout => {
  const bare = options.bare ?? false;
  const avail = bare ? width : width - PAD.length;
  const nameCols = Math.min(
    NAME_COLS_MAX,
    widest(rows.map((row) => theme.width(nestPrefix(row)) + theme.width(nameText(row)))),
  );
  const lead = (bare ? 0 : POINTER_COLS) + GLYPH_COLS + nameCols;
  const wanted = Math.min(
    DESCRIPTION_COLS_MAX,
    widest(rows.map((row) => theme.width(singleLine(row.record.description)))),
  );
  const floor = Math.min(MIN_DESCRIPTION, wanted);
  const status = widest(rows.map((row) => plainWidth(statusOf(row.record, now), theme)));
  const models = Math.min(
    MODEL_COLS_MAX,
    widest(rows.map((row) => theme.width(modelId(row.record.model ?? "")))),
  );
  const modelGap = models > 0 ? models + GAP.length : 0;
  const descriptionGap = wanted > 0 ? GAP.length : 0;
  const fitsModel = modelGap > 0 && lead + descriptionGap + wanted + modelGap + GAP.length + status <= avail;
  const modelCols = fitsModel ? models : 0;
  const room = avail - lead - descriptionGap - (fitsModel ? modelGap : 0) - GAP.length;
  const descriptionCols = Math.max(floor, Math.min(wanted, room - status));

  return {
    nameCols,
    descriptionCols,
    modelCols,
    statusCols: Math.max(0, room - descriptionCols),
    now,
    spinner: options.spinner ?? true,
    bare,
  };
};

const paintName = (input: RowInput, cols: number, theme: ThemeLike) => {
  const base = input.record.agent;
  const tail = chainSuffix(input.record.chainIndex) + countSuffix(input.openDescendants);
  const token = isClosed(input.record.state) ? "muted" : "text";
  const whole = `${base}${tail}`;
  const cut = theme.truncate(whole, Math.max(0, cols));
  const painted =
    cut === whole ? theme.fg(token, base) + (tail ? theme.fg("dim", tail) : "") : theme.fg(token, cut);

  return painted + " ".repeat(Math.max(0, cols - theme.width(cut)));
};

const cell = (theme: ThemeLike, text: string, cols: number, paint: (text: string) => string) => {
  const cut = theme.truncate(text, cols);

  return padEndCols(theme, cut ? paint(cut) : "", cols);
};

export const renderRow = (input: RowInput, width: number, theme: ThemeLike, layout: RowLayout): string => {
  const { record } = input;
  const pointer = input.selected ? `${pointerMark(theme, true)} ` : POINTER_BLANK;
  const lead = layout.bare ? "" : `${PAD}${pointer}`;
  const prefix = nestPrefix(input);
  const glyph = layout.spinner
    ? liveGlyph(record.state, layout.now, theme)
    : scrollGlyph(record.state, theme);
  const name = paintName(input, layout.nameCols - theme.width(prefix), theme);
  const description =
    layout.descriptionCols > 0
      ? `${GAP}${cell(theme, singleLine(record.description), layout.descriptionCols, (text) => theme.fg("muted", text))}`
      : "";
  const model =
    layout.modelCols > 0
      ? `${GAP}${cell(theme, modelLabel(theme, modelId(record.model ?? ""), layout.modelCols), layout.modelCols, (text) => theme.fg("dim", text))}`
      : "";
  const status = receiptText(statusOf(record, layout.now), layout.statusCols, theme);
  const line = `${lead}${prefix ? theme.fg("dim", prefix) : ""}${glyph} ${name}${description}${model}${GAP}${status}`;

  return theme.truncate(line, width);
};

export const renderRows = (
  rows: readonly RowInput[],
  now: number,
  width: number,
  theme: ThemeLike,
  options: RowOptions = {},
): string[] => {
  const layout = rowLayout(rows, now, width, theme, options);

  return rows.map((row) => renderRow(row, width, theme, layout));
};
