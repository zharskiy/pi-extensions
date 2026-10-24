import type { CodemodeShortfall } from "../types/contract.ts";

export const CODEMODE_WORKERS_SETTING = "PI_CODEMODE_MAX_WORKERS";

const SPARE_WORKERS = 2;

const OWNED_KEY = Symbol.for("pi-extensions.codemode-workers");

const shared = globalThis as typeof globalThis & { [OWNED_KEY]?: string };

const positiveInteger = (raw: string | undefined) => {
  const value = Number(raw);

  return Number.isInteger(value) && value > 0 ? value : undefined;
};

export const reserveCodemodeWorkers = (agentSessions: number): CodemodeShortfall | undefined => {
  const wanted = agentSessions + SPARE_WORKERS;
  const current = process.env[CODEMODE_WORKERS_SETTING];
  const explicit = current === shared[OWNED_KEY] ? undefined : positiveInteger(current);

  if (explicit === undefined) {
    const value = String(wanted);

    process.env[CODEMODE_WORKERS_SETTING] = value;
    shared[OWNED_KEY] = value;

    return undefined;
  }

  return explicit < wanted ? { setting: CODEMODE_WORKERS_SETTING, workers: explicit, wanted } : undefined;
};
