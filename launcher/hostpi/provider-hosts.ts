import { type CommandRunner, LauncherError } from "../shared/index.ts";
import type { BundledPi, ProviderHosts } from "./types.ts";

export interface ProviderHostsInput {
  stateDir: string;
  runner: CommandRunner;
  pi: BundledPi;
  imagePiVersion: string;
}

export interface ProviderHostsResult {
  hosts: ProviderHosts;
  notices: string[];
}

export const locateBundledPi = async (): Promise<BundledPi | undefined> => {
  throw new LauncherError("locateBundledPi is not implemented");
};

export const readProviderHosts = async (_input: ProviderHostsInput): Promise<ProviderHostsResult> => {
  throw new LauncherError("readProviderHosts is not implemented");
};
