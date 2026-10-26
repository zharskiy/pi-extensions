import {
  AGENT_AUDIENCE,
  AGENT_REASON,
  handoffInstruction,
  validateHandoff,
} from "../../../../platform/shared/index.ts";
import type { HandoffService } from "../model/agent-record.ts";

export const createHandoff = (): HandoffService => ({
  instruction: (path) => handoffInstruction({ path, reason: AGENT_REASON, audience: AGENT_AUDIENCE }),
  validate: (text) => validateHandoff(text, AGENT_AUDIENCE.statuses),
});
