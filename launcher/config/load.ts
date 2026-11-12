import { errorMessage, LauncherError, launcherPaths, readJsonFile } from "../shared/index.ts";
import { defaultConfig } from "./defaults.ts";
import { mergeConfig } from "./merge.ts";
import type { EffectiveConfig } from "./types.ts";
import { validateConfig } from "./validate.ts";

interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const validateConfigFile = (value: unknown, file: string) => {
  try {
    return validateConfig(value);
  } catch (error) {
    throw new LauncherError(errorMessage(error), `fix ${file}`);
  }
};

const readConfig = async (file: string) => {
  const value = await readJsonFile<unknown>(file);

  return value === undefined ? undefined : validateConfigFile(value, file);
};

export const loadEffectiveConfig = async (options: LoadOptions = {}): Promise<EffectiveConfig> => {
  const paths = launcherPaths({ env: options.env, home: options.home });
  const config = await readConfig(paths.userConfigFile);

  return mergeConfig(defaultConfig(), config);
};
