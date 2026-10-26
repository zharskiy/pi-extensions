import { readFileSync } from "node:fs";
import { join } from "node:path";

type HandoffStatus = "done" | "partial" | "blocked";

type HandoffAudience = {
  statuses: readonly HandoffStatus[];
  statusHint: string;
  reader: string;
  extraRules: string[];
  nextHint: string;
};

export const MAIN_AUDIENCE: HandoffAudience = {
  statuses: ["done", "partial", "blocked"],
  statusHint: "for the user's current goal",
  reader: "the session that continues",
  extraRules: [
    "Work already running in the background keeps running, and the switch to the new session waits for it; list it below.",
  ],
  nextHint:
    "When skills of this session fit those steps, end with a line `Skills: <names>` so the next session reads them first.",
};

export const AGENT_AUDIENCE: HandoffAudience = {
  statuses: ["partial", "blocked"],
  statusHint: "",
  reader: "the agent that continues this work",
  extraRules: [],
  nextHint: "",
};

export const AGENT_REASON = "You have reached your context limit. Stop the current work now and hand it off.";

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

type SuccessorSource =
  | { kind: "session"; file?: string; manual: boolean; focus?: string }
  | { kind: "agent"; id: string; link: number; path: string };

const NEXT_SECTION = "Continue from its Next section without asking the user to repeat.";

const sessionPreface = (source: Extract<SuccessorSource, { kind: "session" }>) => {
  const previous = source.file ? `the previous session ${source.file}` : "the previous session";
  const cause = source.manual
    ? "which the user handed off with /session-handoff"
    : "which reached its context limit";
  const lead = `This session continues ${previous}, ${cause}. Its handoff follows; use it as your context and keep helping the user from where it left off. ${NEXT_SECTION}`;
  const focus = source.manual && source.focus ? [`The user said this session is for: ${source.focus}.`] : [];

  return [lead, ...focus].join("\n");
};

export const successorPreface = (source: SuccessorSource) =>
  source.kind === "session"
    ? sessionPreface(source)
    : `You continue the work of agent ${source.id} as link ${source.link} of its chain; it reached its context limit and wrote the handoff below (also saved at ${source.path}). Carry on from its Next section without redoing the work it reports as done.`;

export const seedText = (preface: string, handoff: string) => [preface, "", handoff.trim()].join("\n");
