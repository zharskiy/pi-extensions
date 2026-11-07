import { LauncherError } from "../shared/index.ts";
import type { PackageChange } from "./types.ts";

export const writeBackPackageChange = async (_change: PackageChange): Promise<{ changed: boolean }> => {
  throw new LauncherError("writeBackPackageChange is not implemented");
};
