import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import {
  MAIN_AUDIENCE,
  handoffPath as sharedHandoffPath,
  validateHandoff,
} from "../../../platform/shared/index.ts";

export const handoffPath = (info: SessionInfo) => sharedHandoffPath(info.id, { main: true });

export const validateMainHandoff = (text: string) => validateHandoff(text, MAIN_AUDIENCE.statuses);
