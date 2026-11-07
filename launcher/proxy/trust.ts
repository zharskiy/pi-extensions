import type { ExtraCa } from "../config/index.ts";
import { type CommandRunner, LauncherError } from "../shared/index.ts";

export interface TrustBundleInput {
  stateDir: string;
  runner: CommandRunner;
  platform: NodeJS.Platform;
  sources: ExtraCa[];
}

export interface TrustBundle {
  pemPath: string;
  extraPemPath: string;
  hash: string;
}

export const ensureTrustBundle = async (_input: TrustBundleInput): Promise<TrustBundle> => {
  throw new LauncherError("ensureTrustBundle is not implemented");
};
