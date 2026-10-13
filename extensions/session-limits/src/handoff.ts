import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../../../core/adapter/contract.ts";
import { validateHandoff } from "../../../core/manager/handoff.ts";

const HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;

export const handoffPath = (info: SessionInfo) =>
  join(tmpdir(), "pi-session-limits", `${info.id}-handoff.md`);

export const seedText = (previousSession: string | undefined, handoff: string) => {
  const source = previousSession ? `the previous session ${previousSession}` : "the previous session";

  const preface = `This session continues ${source}, which reached its context limit. Its handoff follows; use it as your context and keep helping the user from where it left off.`;

  return [preface, "", handoff.trim()].join("\n");
};

export const validateMainHandoff = (text: string) => validateHandoff(text, HANDOFF_STATUSES);
