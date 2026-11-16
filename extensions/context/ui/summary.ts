import { DOT, formatPercent, formatTokens, formatWindow } from "../../../platform/shared/index.ts";
import { NO_MODEL } from "../../../platform/ui-kit/index.ts";
import { type CacheFigures, type UsageModel, usageModel } from "../core/breakdown.ts";
import type { Snapshot } from "../core/snapshot.ts";

export type SummaryPaint = {
  name: (text: string) => string;
  note: (text: string) => string;
  percent: (value: number, missed: boolean) => string;
  dot: string;
};

const plain = (text: string) => text;

const PLAIN: SummaryPaint = { name: plain, note: plain, percent: (value) => formatPercent(value), dot: DOT };

const modelName = (model: UsageModel) => model.model ?? NO_MODEL;

const figuresText = (model: UsageModel, unit: boolean) => {
  const mark = model.estimated ? "~" : "";

  return `${mark}${formatTokens(model.used)}/${formatWindow(model.window)}${unit ? " tokens" : ""} (${formatPercent(model.percent)})`;
};

export const headerText = (model: UsageModel, unit = true, paint = PLAIN) =>
  [
    paint.name(modelName(model)),
    figuresText(model, unit),
    ...(model.estimated ? [paint.note("estimated")] : []),
  ].join(paint.dot);

export const cacheText = (cache: CacheFigures, paint = PLAIN) => {
  const last =
    cache.lastTurn === undefined ? [] : [`last turn ${paint.percent(cache.lastTurn, cache.lastMissed)}`];

  return `Cache hit: ${[...last, `session ${paint.percent(cache.session, false)}`].join(paint.dot)}`;
};

export const summaryLine = (snapshot: Snapshot) => {
  const model = usageModel(snapshot);

  return [`Context: ${headerText(model)}`, ...(model.cache ? [cacheText(model.cache)] : [])].join(DOT);
};
