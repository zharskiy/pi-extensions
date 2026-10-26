import {
  AGENT_AUDIENCE,
  AGENT_REASON,
  handoffInstruction,
  validateHandoff,
} from "../../../../platform/shared/index.ts";

export const handoffService = {
  instruction: (path: string) => handoffInstruction({ path, reason: AGENT_REASON, audience: AGENT_AUDIENCE }),
  validate: (text: string) => validateHandoff(text, AGENT_AUDIENCE.statuses),
};
