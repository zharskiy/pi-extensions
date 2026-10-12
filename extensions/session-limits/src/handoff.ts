import { join } from "node:path";
import type { SessionInfo } from "../../../core/adapter/contract.ts";
import { validateHandoff } from "../../../core/manager/handoff.ts";
import { sessionDataDir } from "../../../core/manager/paths.ts";

const HANDOFF_FILE = "main-handoff.md";

const HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;

export const handoffPath = (info: SessionInfo) =>
  join(sessionDataDir(info, "pi-session-limits"), HANDOFF_FILE);

export const seedText = (previousSession: string | undefined, handoff: string) => {
  const source = previousSession ? `the previous session ${previousSession}` : "the previous session";

  const preface = `This session continues ${source}, which reached its context limit. Its handoff follows; use it as your context and keep helping the user from where it left off.`;

  return [preface, "", handoff.trim()].join("\n");
};

export const validateMainHandoff = (text: string) => validateHandoff(text, HANDOFF_STATUSES);
