import {
  AGENT_AUDIENCE,
  AGENT_REASON,
  handoffInstruction,
  handoffTemplate,
  validateHandoff,
} from "../../../../platform/shared/index.ts";
import type { HandoffService } from "../model/agent-record.ts";

export const createHandoff = (): HandoffService => {
  const template = handoffTemplate();

  return {
    instruction: (path) =>
      handoffInstruction(template, { path, reason: AGENT_REASON, audience: AGENT_AUDIENCE }),
    validate: (text) => validateHandoff(text, ["partial", "blocked"]),
  };
};
