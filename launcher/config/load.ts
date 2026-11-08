import {
  errorMessage,
  LauncherError,
  launcherPaths,
  projectConfigFile,
  readJsonFile,
} from "../shared/index.ts";
import { defaultConfig } from "./defaults.ts";
import { mergeLayers } from "./merge.ts";
import type { EffectiveConfig, LayerName } from "./types.ts";
import { projectKeyRefusal, validateLayer } from "./validate.ts";

interface LoadOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
}

const layerFile = (layer: Exclude<LayerName, "org">, repoRoot: string, env?: NodeJS.ProcessEnv) => {
  if (layer === "project") {
    return projectConfigFile(repoRoot);
  }

  const paths = launcherPaths({ env });

  return layer === "policy" ? paths.policyFile : paths.userConfigFile;
};

const validated = (value: unknown, layer: LayerName, file: string) => {
  try {
    return validateLayer(value, layer);
  } catch (error) {
    throw new LauncherError(errorMessage(error), `fix ${file}`);
  }
};

export const validateLayerFile = (value: unknown, layer: LayerName, file: string) => {
  const refused = layer === "project" ? projectKeyRefusal(value, file) : undefined;

  if (refused !== undefined) {
    throw refused;
  }

  return validated(value, layer, file);
};

const readLayer = async (layer: LayerName, file: string) => {
  const value = await readJsonFile<unknown>(file);

  return value === undefined ? undefined : validateLayerFile(value, layer, file);
};

const readOrg = async (file: string | undefined) => {
  if (file === undefined) {
    return undefined;
  }

  const layer = await readLayer("org", file);

  if (layer === undefined) {
    throw new LauncherError(
      `org: ${file} does not exist`,
      "fix org in the config, or ask your administrator",
    );
  }

  return layer;
};

export const loadEffectiveConfig = async (options: LoadOptions): Promise<EffectiveConfig> => {
  const [policy, user, project] = await Promise.all(
    (["policy", "user", "project"] as const).map((layer) =>
      readLayer(layer, layerFile(layer, options.repoRoot, options.env)),
    ),
  );
  const org = await readOrg(policy?.org ?? user?.org);

  return mergeLayers({ defaults: await defaultConfig(), layers: { policy, org, user, project } });
};
