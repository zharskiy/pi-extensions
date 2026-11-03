export const BACKEND_NAMES = ["colima", "apple"] as const;

export type BackendName = (typeof BACKEND_NAMES)[number];
