import type { SessionInfo, UserMessage } from "../../../platform/pi-adapter/index.ts";
import {
  type HandoffAudience,
  handoffPath as sharedHandoffPath,
  validateHandoff,
} from "../../../platform/shared/index.ts";

export const HANDOFF_COMMAND = "session-handoff";

export const MAIN_AUDIENCE: HandoffAudience = {
  statuses: ["done", "partial", "blocked"],
  statusHint: "for the user's current goal",
  reader: "the session that continues",
  extraRules: [
    "Background work still running keeps running, and the automatic switch waits for it: list each piece under Evidence with its id, what runs it, the question it answers and what you will do with its result, and put that use under Next. Results that arrive later are attached to the new session's seed.",
  ],
  nextHint:
    "When skills of this session fit those steps, end with a line `Skills: <names>` so the next session reads them first.",
};

const HELD_HEADING = "Batch results that arrived while the handoff was pending:";

export const withLateResults = (text: string, late: string[]) =>
  late.length === 0 ? text : [text.trim(), HELD_HEADING, ...late].join("\n\n");

export const joinParagraphs = (texts: string[]) =>
  texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");

const isCommand = (text: string) => text.trimStart().startsWith("/");

const asSent = (message: UserMessage): UserMessage =>
  isCommand(message.text) ? { ...message, text: message.text.trimStart() } : message;

const merged = (first: UserMessage, next: UserMessage): UserMessage => ({
  text: joinParagraphs([first.text, next.text]),
  images: [...first.images, ...next.images],
});

const startsPrompt = (message: UserMessage, index: number, messages: UserMessage[]) =>
  index === 0 || isCommand(message.text) || isCommand(messages[index - 1]?.text ?? "");

export const userPrompts = (messages: UserMessage[]) => {
  const sent = messages.map(asSent);
  const starts = sent.flatMap((message, index) => (startsPrompt(message, index, sent) ? [index] : []));

  return starts.map((start, at) => sent.slice(start, starts[at + 1]).reduce(merged));
};

type SessionSource = { file?: string; manual: boolean; focus?: string };

export const sessionPreface = ({ file, manual, focus }: SessionSource) => {
  const previous = file ? `the previous session ${file}` : "the previous session";
  const cause = manual
    ? `which the user handed off with /${HANDOFF_COMMAND}`
    : "which reached its context limit";
  const lead = `This session continues ${previous}, ${cause}. Its handoff follows; use it as your context and keep helping the user from where it left off. Continue from its Next section without asking the user to repeat.`;
  const focusLine = manual && focus ? [`The user said this session is for: ${focus}.`] : [];

  return [lead, ...focusLine].join("\n");
};

export const handoffPath = (info: SessionInfo) => sharedHandoffPath(info.id, { main: true });

export const validateMainHandoff = (text: string) => validateHandoff(text, MAIN_AUDIENCE.statuses);
