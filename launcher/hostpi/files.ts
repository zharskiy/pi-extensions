import { LauncherError } from "../shared/index.ts";
import type { HostPiFiles } from "./types.ts";

export const readHostPiFiles = async (_agentDir: string): Promise<HostPiFiles> => {
  throw new LauncherError("readHostPiFiles is not implemented");
};
