import { type EntryRender, labelledRule } from "../../../platform/pi-adapter/index.ts";
import { answerLabel, parseAnswer } from "../core/turn-summary.ts";

export const answerRule: EntryRender = (data, width, _expanded, theme) => {
  const answer = parseAnswer(data);

  if (!answer) {
    return [];
  }

  return [labelledRule(theme, width, answerLabel(answer))];
};
