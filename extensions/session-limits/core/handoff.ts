import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
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
    "Work already running in the background keeps running, and the switch to the new session waits for it; list it below.",
  ],
  nextHint:
    "When skills of this session fit those steps, end with a line `Skills: <names>` so the next session reads them first.",
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
