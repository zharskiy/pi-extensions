import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { handoffPath as sharedHandoffPath, validateHandoff } from "../../../platform/shared/index.ts";

const HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;

export const handoffPath = (info: SessionInfo) => sharedHandoffPath(info.id, { main: true });

export const validateMainHandoff = (text: string) => validateHandoff(text, HANDOFF_STATUSES);
