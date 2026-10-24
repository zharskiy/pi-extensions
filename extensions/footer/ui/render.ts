import {
  type ContextSnapshot,
  type FooterData,
  type ModelInfo,
  PAD,
  type ThemeLike,
  type ThemeToken,
} from "../../../platform/pi-adapter/index.ts";
import {
  DOT,
  formatMoney,
  formatTokens,
  formatWindow,
  type SpendingTotals,
} from "../../../platform/shared/index.ts";
import { cachePercentText } from "../../../platform/ui-kit/index.ts";
import { type FooterState, folderName, sessionSpend, statusLines } from "../core/segments.ts";

const LEVEL_TOKENS: Record<string, ThemeToken> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const looksLikeGauge = (theme: ThemeLike, token: ThemeToken) =>
  theme.fg(token, "x") === theme.fg("success", "x");

const branchToken = (theme: ThemeLike): ThemeToken =>
  looksLikeGauge(theme, "syntaxString") ? "syntaxVariable" : "syntaxString";

const SPEND: ThemeToken = "text";

const PLACE: ThemeToken = "border";

const MODEL: ThemeToken = "borderAccent";

const META: ThemeToken = "muted";

const HINT: ThemeToken = "dim";

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
      ...(state.totals === undefined ? [] : [theme.fg(SPEND, formatMoney(state.totals.main.cost))]),
      modelText(theme, state.context, state.model),
    ].join(theme.fg(META, DOT));
  const full = join(state.cache);

  return theme.width(`${PAD}${full}`) > width ? join(undefined) : full;
};

const sessionLine = (theme: ThemeLike, totals: SpendingTotals) => {
  const { tokens, cost } = sessionSpend(totals);

  return [
    theme.fg(META, "session total (agents included) "),
    theme.fg(SPEND, formatTokens(tokens)),
    theme.fg(META, DOT),
    theme.fg(SPEND, formatMoney(cost)),
    ...(totals.subscription ? [theme.fg(META, " (sub)")] : []),
  ].join("");
};

const placeLine = (theme: ThemeLike, cwd: string, branch: string | null, sessionName: string | undefined) => {
  const folder = theme.fg(PLACE, folderName(cwd));
  const place = branch
    ? `${folder}${theme.fg(META, " git:(")}${theme.fg(branchToken(theme), branch)}${theme.fg(META, ")")}`
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
