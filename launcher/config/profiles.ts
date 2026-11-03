import { join } from "node:path";
import { LauncherError, launcherRoot, readJsonFile } from "../shared/index.ts";
import type { LayerConfig, ProfileName } from "./types.ts";
import { validateLayer } from "./validate.ts";

const PROFILE_NAMES: readonly string[] = ["enterprise", "team", "solo"] satisfies ProfileName[];

export const loadProfile = async (name: string): Promise<LayerConfig> => {
  if (!PROFILE_NAMES.includes(name)) {
    throw new LauncherError(`profile ${name}: unknown profile`, `use one of ${PROFILE_NAMES.join(", ")}`);
  }

  const file = join(launcherRoot(), "profiles", `${name}.json`);
  const value = await readJsonFile<unknown>(file);

  if (value === undefined) {
    throw new LauncherError(`profile ${name}: ${file} is missing`, "reinstall the launcher");
  }

  return validateLayer(value, `profile ${name}`);
};
