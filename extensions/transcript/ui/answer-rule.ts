import type { EntryRender } from "../../../platform/pi-adapter/index.ts";
import { labelledRule } from "../../../platform/ui-kit/index.ts";
import { answerLabel, parseAnswer } from "../core/turn-summary.ts";

export const answerRule: EntryRender = (data, width, _expanded, theme) => {
  const answer = parseAnswer(data);

  if (!answer) {
    return [];
  }

  return [labelledRule(theme, width, answerLabel(answer))];
};
