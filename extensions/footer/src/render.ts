import type {
  ContextSnapshot,
  FooterData,
  ModelInfo,
  ThemeLike,
  ThemeToken,
} from "../../../core/adapter/contract.ts";
import { cachePercentText } from "../../../core/manager/cache.ts";
import { SPENDING_STATUS_KEY, type SpendingTotals } from "../../../core/manager/channels.ts";
import { formatCost, formatTokens, formatWindow } from "../../../core/manager/format.ts";
import { DOT, PAD } from "../../../core/manager/layout.ts";

const LEVEL_TOKENS: Record<string, ThemeToken> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

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

const money = (cost: number) => formatCost(cost, { zero: "show" }) ?? "$0.00";

const SPEND: ThemeToken = "text";

const PLACE: ThemeToken = "border";

const MODEL: ThemeToken = "syntaxVariable";

const BRANCH: ThemeToken = "borderAccent";

const META: ThemeToken = "muted";

const HINT: ThemeToken = "dim";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const contextTokens = (theme: ThemeLike, context: ContextSnapshot) => {
  if (context.tokens === null) {
    return theme.fg(META, "?");
  }

  const text = formatTokens(context.tokens);
  const percent = context.percent ?? 0;

  if (percent > 90) {
    return theme.fg("error", text);
  }

  if (percent > 70) {
    return theme.fg("warning", text);
  }

  return theme.fg("success", text);
};

const modelText = (theme: ThemeLike, context: ContextSnapshot, model: ModelInfo | undefined) => {
  if (!model) {
    return theme.fg(META, "no model");
  }

  const window = `(${formatWindow(model.contextWindow || context.window)} context)`;

  return `${theme.fg(MODEL, model.name)} ${theme.fg(META, window)}`;
};

const cacheSegment = (theme: ThemeLike, percent: number) =>
  `${theme.fg(META, "cache ")}${cachePercentText(theme, percent)}`;

const statsLine = (theme: ThemeLike, state: FooterState, width: number) => {
  const join = (cache: number | undefined) =>
    [
      contextTokens(theme, state.context),
      ...(cache === undefined ? [] : [cacheSegment(theme, cache)]),
      ...(state.totals === undefined ? [] : [theme.fg(SPEND, money(state.totals.main.cost))]),
      modelText(theme, state.context, state.model),
    ].join(theme.fg(META, DOT));
  const full = join(state.cache);

  return theme.width(`${PAD}${full}`) > width ? join(undefined) : full;
};

const sessionLine = (theme: ThemeLike, totals: SpendingTotals) => {
  const all = [totals.main, ...totals.sources];
  const tokens = all.reduce((sum, spend) => sum + spend.tokens, 0);
  const cost = all.reduce((sum, spend) => sum + spend.cost, 0);

  return [
    theme.fg(META, "session total (agents included) "),
    theme.fg(SPEND, formatTokens(tokens)),
    theme.fg(META, DOT),
    theme.fg(SPEND, money(cost)),
    ...(totals.subscription ? [theme.fg(META, " (sub)")] : []),
  ].join("");
};

const placeLine = (theme: ThemeLike, cwd: string, branch: string | null, sessionName: string | undefined) => {
  const folder = theme.fg(PLACE, folderName(cwd));
  const place = branch
    ? `${folder}${theme.fg(META, " git:(")}${theme.fg(BRANCH, branch)}${theme.fg(META, ")")}`
    : folder;

  return sessionName ? `${place}${theme.fg(META, ` • ${sessionName}`)}` : place;
};

const modeLine = (theme: ThemeLike, model: ModelInfo | undefined, thinking: string, cycleKey: string) => {
  const name = thinking || "off";
  const level =
    model?.reasoning === false
      ? theme.fg(META, "thinking unavailable")
      : theme.bold(theme.fg(LEVEL_TOKENS[name] ?? "thinkingOff", `thinking ${name}`));

  return `${level} ${theme.fg(HINT, `(${cycleKey} to cycle)`)}`;
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
