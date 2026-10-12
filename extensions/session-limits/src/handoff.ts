import { join } from "node:path";
import type { SessionInfo } from "../../../core/adapter/contract.ts";
import { validateHandoff as validateSections } from "../../../core/manager/handoff.ts";
import { sessionDataDir } from "../../../core/manager/paths.ts";

const HANDOFF_FILE = "main-handoff.md";

const HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;

export const handoffPath = (info: SessionInfo | undefined) =>
  join(sessionDataDir(info, "pi-session-limits"), HANDOFF_FILE);

export const instructionFor = (template: string, path: string) =>
  template.replaceAll("{{path}}", path).trim();

export const seedText = (previousSession: string | undefined, handoff: string) => {
  const source = previousSession ? `the previous session ${previousSession}` : "the previous session";

  const preface = `This session continues ${source}, which reached its context limit. Its handoff follows; use it as your context and keep helping the user from where it left off.`;

  return [preface, "", handoff.trim()].join("\n");
};

export const validateHandoff = (text: string) => validateSections(text, HANDOFF_STATUSES);
