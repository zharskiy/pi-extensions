import { DOT, formatTokens, formatWindow } from "../../../platform/shared/index.ts";
import { type UsageModel, usageModel } from "../core/breakdown.ts";
import type { Snapshot } from "../core/snapshot.ts";

export const modelName = (model: UsageModel) => model.model ?? "no model";

export const figuresText = (model: UsageModel, unit = true) => {
  const mark = model.estimated ? "~" : "";

  return `${mark}${formatTokens(model.used)}/${formatWindow(model.window)}${unit ? " tokens" : ""} (${Math.round(model.percent)}%)`;
};

const cacheText = (model: UsageModel) => {
  if (!model.cache) {
    return [];
  }

  const last = model.cache.lastTurn === undefined ? [] : [`last turn ${Math.round(model.cache.lastTurn)}%`];

  return [`Cache hit: ${[...last, `session ${Math.round(model.cache.session)}%`].join(DOT)}`];
};

export const summaryLine = (snapshot: Snapshot) => {
  const model = usageModel(snapshot);

  return [
    `Context: ${modelName(model)}`,
    figuresText(model),
    ...(model.estimated ? ["estimated"] : []),
    ...cacheText(model),
  ].join(DOT);
};
