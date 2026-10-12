import { validateHandoff as validateSections } from "../../../../../core/manager/handoff.ts";

export const HANDOFF_STATUSES = ["partial", "blocked"] as const;

export const validateHandoff = (text: string) => validateSections(text, HANDOFF_STATUSES);
