import type { CliDeps } from "../deps.ts";
import { runDoctor } from "./doctor.ts";

export const SMOKE_DOCTOR = "__smoke-doctor";

const SANDBOX_SKIPPED_EXIT = 3;

export const smokeDoctorCommand = async (deps: CliDeps) => {
  const { code, skipsSandbox } = await runDoctor(deps, []);

  return code === 0 && skipsSandbox ? SANDBOX_SKIPPED_EXIT : code;
};
