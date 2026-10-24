import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../../../pi-adapter/index.ts";
import { validateHandoff } from "../../../shared/index.ts";

const HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;

export const handoffPath = (info: SessionInfo) =>
  join(tmpdir(), "pi-session-limits", `${info.id}-handoff.md`);

type SeedOptions = { manual?: boolean; focus?: string };

export const seedText = (previousSession: string | undefined, handoff: string, options: SeedOptions = {}) => {
  const source = previousSession ? `the previous session ${previousSession}` : "the previous session";
  const cause = options.manual
    ? "which the user handed off with /session-handoff"
    : "which reached its context limit";
  const preface = `This session continues ${source}, ${cause}. Its handoff follows; use it as your context and keep helping the user from where it left off.`;
  const focus =
    options.manual && options.focus ? [`The user said this session is for: ${options.focus}.`] : [];

  return [preface, ...focus, "", handoff.trim()].join("\n");
};

export const validateMainHandoff = (text: string) => validateHandoff(text, HANDOFF_STATUSES);
