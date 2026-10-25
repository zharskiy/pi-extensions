import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { validateHandoff } from "../../../platform/shared/index.ts";

const HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;

export const handoffPath = (info: SessionInfo) =>
  join(tmpdir(), "pi-session-limits", `${info.id}-handoff.md`);

export const validateMainHandoff = (text: string) => validateHandoff(text, HANDOFF_STATUSES);
