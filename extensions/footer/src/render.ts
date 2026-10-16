import type { ContextSnapshot, FooterData, ModelInfo, ThemeLike } from "../../../core/adapter/contract.ts";
import { cacheTone } from "../../../core/manager/cache.ts";
import { SPENDING_STATUS_KEY, type SpendingTotals } from "../../../core/manager/channels.ts";
import { formatTokens } from "../../../core/manager/format.ts";

const PAD = " ";

const DOT = " · ";

const MODE_MARK = "▶▶";

const RESET = "\x1b[0m";

const BOLD = "\x1b[1m";

const COLORS = {
  green: "\x1b[38;5;151m",
  gold: "\x1b[38;5;186m",
  cyan: "\x1b[38;5;152m",
  blue: "\x1b[38;5;153m",
  yellow: "\x1b[38;5;223m",
} as const;

export type FooterState = {
  context: ContextSnapshot;
  model: ModelInfo | undefined;
  thinking: string;
  cycleKey: string;
  cwd: string;
  sessionName: string | undefined;
  totals: SpendingTotals | undefined;
  cache: number | undefined;
};

const paint = (color: string, text: string) => `${color}${text}${RESET}`;

const paintBold = (color: string, text: string) => `${BOLD}${color}${text}${RESET}`;

const formatCost = (cost: number) => {
  if (cost <= 0) {
    return "$0.00";
  }

  return cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
};

const formatWindow = (count: number) => {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;

    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }

  if (count >= 1000) {
    return `${Math.round(count / 1000)}k`;
  }

  return `${count}`;
};

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const contextTokens = (theme: ThemeLike, context: ContextSnapshot) => {
  if (context.tokens === null) {
    return theme.fg("dim", "?");
  }

  const text = formatTokens(context.tokens);
  const percent = context.percent ?? 0;

  if (percent > 90) {
    return theme.fg("error", text);
  }

  if (percent > 70) {
    return theme.fg("warning", text);
  }

  return paint(COLORS.green, text);
};

const modelText = (context: ContextSnapshot, model: ModelInfo | undefined) => {
  if (!model) {
    return "no model";
  }

  return `${model.name} (${formatWindow(model.contextWindow || context.window)} context)`;
};

const cacheSegment = (theme: ThemeLike, percent: number) =>
  `${theme.fg("dim", "cache ")}${theme.fg(cacheTone(percent), `${Math.round(percent)}%`)}`;

const statsLine = (theme: ThemeLike, state: FooterState, width: number) => {
  const join = (cache: number | undefined) =>
    [
      contextTokens(theme, state.context),
      ...(cache === undefined ? [] : [cacheSegment(theme, cache)]),
      ...(state.totals === undefined ? [] : [paint(COLORS.gold, formatCost(state.totals.main.cost))]),
      paint(COLORS.cyan, modelText(state.context, state.model)),
    ].join(theme.fg("dim", DOT));
  const full = join(state.cache);

  return theme.width(`${PAD}${full}`) > width ? join(undefined) : full;
};

const sessionLine = (theme: ThemeLike, totals: SpendingTotals) => {
  const all = [totals.main, ...totals.sources];
  const tokens = all.reduce((sum, spend) => sum + spend.tokens, 0);
  const cost = all.reduce((sum, spend) => sum + spend.cost, 0);

  return [
    theme.fg("dim", "session total (agents included) "),
    paint(COLORS.green, formatTokens(tokens)),
    theme.fg("dim", " / "),
    paint(COLORS.gold, formatCost(cost)),
    ...(totals.subscription ? [theme.fg("dim", " (sub)")] : []),
  ].join("");
};

const placeLine = (theme: ThemeLike, cwd: string, branch: string | null, sessionName: string | undefined) => {
  const folder = paint(COLORS.blue, folderName(cwd));
  const place = branch ? `${folder} ${paint(COLORS.yellow, `git:(${branch})`)}` : folder;

  return sessionName ? `${place}${theme.fg("dim", ` • ${sessionName}`)}` : place;
};

const modeLine = (theme: ThemeLike, model: ModelInfo | undefined, thinking: string, cycleKey: string) => {
  const level =
    model?.reasoning === false
      ? theme.fg("dim", "thinking unavailable")
      : `${theme.fg("dim", "thinking ")}${paintBold(COLORS.gold, thinking || "off")}`;

  return `${paint(COLORS.gold, MODE_MARK)} ${level} ${theme.fg("dim", `(${cycleKey} to cycle)`)}`;
};

const statusLines = (statuses: ReadonlyMap<string, string>): string[] =>
  Array.from(statuses)
    .filter(([key]) => key !== SPENDING_STATUS_KEY)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);

export const renderFooter = (
  theme: ThemeLike,
  state: FooterState,
  data: FooterData,
  width = Number.POSITIVE_INFINITY,
) => {
  const status = statusLines(data.statuses);
  const lines = [
    statsLine(theme, state, width),
    ...(state.totals ? [sessionLine(theme, state.totals)] : []),
    placeLine(theme, state.cwd, data.branch, state.sessionName),
    modeLine(theme, state.model, state.thinking, state.cycleKey),
    ...(status.length > 0 ? ["", ...status] : []),
  ];

  return ["", ...lines.map((line) => (line ? `${PAD}${line}` : line)), ""];
};
