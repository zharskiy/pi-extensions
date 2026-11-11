import { errorMessage, LauncherError, launcherPaths, readJsonFile } from "../shared/index.ts";
import { defaultConfig } from "./defaults.ts";
import { mergeLayers } from "./merge.ts";
import type { EffectiveConfig, LayerName } from "./types.ts";
import { validateLayer } from "./validate.ts";

interface LoadOptions {
  env?: NodeJS.ProcessEnv;
}

const validateLayerFile = (value: unknown, layer: LayerName, file: string) => {
  try {
    return validateLayer(value, layer);
  } catch (error) {
    throw new LauncherError(errorMessage(error), `fix ${file}`);
  }
};

const readLayer = async (layer: LayerName, file: string) => {
  const value = await readJsonFile<unknown>(file);

  return value === undefined ? undefined : validateLayerFile(value, layer, file);
};

export const loadEffectiveConfig = async (options: LoadOptions = {}): Promise<EffectiveConfig> => {
  const paths = launcherPaths({ env: options.env });
  const [policy, user] = await Promise.all([
    readLayer("policy", paths.policyFile),
    readLayer("user", paths.userConfigFile),
  ]);

  return mergeLayers({ defaults: defaultConfig(), layers: { policy, user } });
};
