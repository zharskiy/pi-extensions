import { LauncherError } from "../shared/index.ts";
import type { DerivedSandboxPi, DeriveInput } from "./types.ts";

export const deriveSandboxPi = (_input: DeriveInput): DerivedSandboxPi => {
  throw new LauncherError("deriveSandboxPi is not implemented");
};
