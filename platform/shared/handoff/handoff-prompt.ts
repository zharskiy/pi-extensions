import { readFileSync } from "node:fs";
import { join } from "node:path";

type HandoffStatus = "done" | "partial" | "blocked";

export type HandoffAudience = {
  statuses: readonly HandoffStatus[];
  statusHint: string;
  reader: string;
  extraRules: string[];
  nextHint: string;
};

type HandoffRequest = { path: string; reason: string; focus?: string; audience: HandoffAudience };

let cachedTemplate: string | undefined;

const handoffTemplate = () => {
  cachedTemplate ??= readFileSync(join(import.meta.dirname, "handoff-prompt.md"), "utf8");

  return cachedTemplate;
};

const orList = (words: readonly string[]) =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;

const withLead = (text: string) => (text ? ` ${text}` : "");

const focusParagraph = (focus: string | undefined) =>
  focus
    ? `\n\nThe user says the next session is for: ${focus}. Shape Outcome and Next around that and leave out what it does not need.\n\n`
    : "\n\n";

export const handoffInstruction = (request: HandoffRequest) => {
  const { audience } = request;

  const values: Record<string, string> = {
    reason: request.reason,
    path: request.path,
    reader: audience.reader,
    statuses: orList(audience.statuses),
    statusHint: withLead(audience.statusHint),
    extraRules: audience.extraRules.map(withLead).join(""),
    nextHint: withLead(audience.nextHint),
  };

  return handoffTemplate()
    .replace(/\n*\{\{focus\}\}\n*/, () => focusParagraph(request.focus))
    .replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
    .trim();
};

export const handoffRetry = (instruction: string, errors: string[]) =>
  [
    instruction,
    "",
    "The handoff was not accepted:",
    ...errors.map((error) => `- ${error}`),
    "Call the `handoff` tool again with the whole handoff fixed.",
  ].join("\n");

export const seedText = (preface: string, handoff: string) => [preface, "", handoff.trim()].join("\n");
