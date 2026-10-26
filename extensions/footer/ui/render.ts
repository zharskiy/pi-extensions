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
import { keyHints } from "../../../platform/ui-kit/index.ts";
import {
  agentsHint,
  type ContextBase,
  contextBase,
  type FooterState,
  folderName,
  sessionSpend,
  statusLines,
} from "../core/segments.ts";
import { type Segment, spread } from "./layout.ts";

const LEVEL_TOKENS: Record<string, ThemeToken> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const NEVER = Number.POSITIVE_INFINITY;

const SUBSCRIPTION = " on subscription";

const SUBSCRIPTION_SHORT = " on sub";

const placeSegments = (
  theme: ThemeLike,
  cwd: string,
  branch: string | null,
  sessionName: string | undefined,
): Segment[] => [
  { text: theme.fg("muted", folderName(cwd)), drop: NEVER },
  ...(branch
    ? [{ text: `${theme.fg("dim", "on ")}${theme.fg("muted", branch)}`, drop: 3, tight: true }]
    : []),
  ...(sessionName ? [{ text: theme.fg("muted", sessionName), drop: 1 }] : []),
];

const modelSegments = (theme: ThemeLike, model: ModelInfo | undefined, thinking: string): Segment[] => {
  const level = thinking || "off";
  const levelText = () =>
    `${theme.fg("dim", "thinking ")}${theme.fg(LEVEL_TOKENS[level] ?? "thinkingOff", level)}`;

  return [
    { text: theme.fg("muted", model?.name ?? "no model"), drop: NEVER },
    ...(model && model.reasoning !== false ? [{ text: levelText(), drop: 2 }] : []),
  ];
};

const contextSegments = (theme: ThemeLike, context: ContextSnapshot, base: ContextBase): Segment[] => {
  const label = theme.fg("dim", "context");

  if (context.tokens === null || base.base <= 0) {
    return [{ text: `${label} ${theme.fg("muted", "?")}`, drop: NEVER }];
  }

  const count = formatTokens(context.tokens);
  const of = `of ${formatWindow(base.base)}`;

  const tone =
    context.tokens >= base.errorAt ? "error" : context.tokens >= base.warnAt ? "warning" : undefined;
  const figure = (text: string) => {
    const painted = theme.fg(tone ?? "text", text);

    return tone === "error" ? theme.bold(painted) : painted;
  };

  return [
    { text: `${label} ${figure(count)}`, drop: NEVER },
    { text: theme.fg(tone ?? "dim", of), drop: 5, tight: true },
  ];
};

const cacheSegments = (theme: ThemeLike, cache: number | undefined): Segment[] =>
  cache === undefined
    ? []
    : [{ text: `${theme.fg("dim", "cache ")}${theme.fg("muted", `${Math.round(cache)}%`)}`, drop: 3 }];

const totalSegment = (theme: ThemeLike, totals: SpendingTotals, labelled: boolean): Segment => {
  const { subscription } = totals;
  const figure = theme.fg(subscription ? "muted" : "text", formatMoney(sessionSpend(totals).cost));
  const form = (label: boolean, suffix: string) =>
    `${figure}${label ? theme.fg("dim", " total") : ""}${suffix ? theme.fg("dim", suffix) : ""}`;
  const tail = subscription ? SUBSCRIPTION_SHORT : "";

  const plain = { text: form(false, tail), drop: NEVER };
  const labelledForm = labelled ? { text: form(true, tail), drop: 4, next: plain } : plain;

  return subscription ? { text: form(labelled, SUBSCRIPTION), drop: 2, next: labelledForm } : labelledForm;
};

const moneySegments = (theme: ThemeLike, totals: SpendingTotals | undefined): Segment[] => {
  if (!totals) {
    return [];
  }

  const agentsCost = totals.sources.reduce((sum, spend) => sum + spend.cost, 0);
  const tokens = {
    text: `${theme.fg("muted", formatTokens(sessionSpend(totals).tokens))}${theme.fg("dim", " tokens")}`,
    drop: 1,
  };
  const split = {
    text: [
      `${theme.fg("muted", formatMoney(totals.main.cost))}${theme.fg("dim", " main")}`,
      `${theme.fg("muted", formatMoney(agentsCost))}${theme.fg("dim", " agents")}`,
    ].join(theme.fg("dim", DOT)),
    drop: 4,
  };

  return agentsCost > 0
    ? [tokens, split, totalSegment(theme, totals, true)]
    : [tokens, totalSegment(theme, totals, false)];
};

const hintRow = (theme: ThemeLike, state: FooterState, hint: string | undefined, width: number) => {
  const cycle: Segment[] =
    state.model && state.model.reasoning !== false
      ? [{ text: keyHints([[state.cycleKey, "to cycle thinking"]], theme), drop: 1 }]
      : [];
  const agents: Segment[] = hint ? [{ text: hint, drop: 2 }] : [];
  const row = [...cycle, ...agents];

  return row.length === 0 ? [] : [spread(theme, row, [], width)];
};

export const renderFooter = (theme: ThemeLike, state: FooterState, data: FooterData, width: number) => {
  const room = width - PAD.length;
  const status = statusLines(data.statuses);
  const place = placeSegments(theme, state.cwd, data.branch, state.sessionName);
  const context = [
    ...contextSegments(theme, state.context, contextBase(state)),
    ...cacheSegments(theme, state.cache),
  ];
  const lines = [
    spread(theme, place, modelSegments(theme, state.model, state.thinking), room),
    spread(theme, context, moneySegments(theme, state.totals), room),
    ...hintRow(theme, state, agentsHint(data.statuses), room),
    ...(status.length > 0 ? ["", ...status] : []),
  ];

  return ["", ...lines.map((line) => (line ? `${PAD}${line}` : line)), ""];
};
