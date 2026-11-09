import {
  errorMessage,
  LauncherError,
  launcherPaths,
  projectConfigFile,
  readJsonFile,
} from "../shared/index.ts";
import { defaultConfig } from "./defaults.ts";
import { mergeLayers } from "./merge.ts";
import type { EffectiveConfig, IgnoredKey, LayerName } from "./types.ts";
import { PROJECT_KEYS, splitProjectKeys, validateLayer } from "./validate.ts";

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

export const validateLayerFile = (value: unknown, layer: LayerName, file: string) =>
  validated(layer === "project" ? splitProjectKeys(value).kept : value, layer, file);

const readLayer = async (layer: LayerName, file: string) => {
  const value = await readJsonFile<unknown>(file);

  return value === undefined ? undefined : validateLayerFile(value, layer, file);
};

const readProject = async (file: string) => {
  const value = await readJsonFile<unknown>(file);

  if (value === undefined) {
    return { layer: undefined, ignored: [] };
  }

  const reason = `a project config may set only ${PROJECT_KEYS.join(", ")}; ${file}`;
  const ignored: IgnoredKey[] = splitProjectKeys(value).outside.map((key) => ({
    layer: "project",
    key,
    reason,
  }));

  return { layer: validateLayerFile(value, "project", file), ignored };
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
  const [policy, user] = await Promise.all(
    (["policy", "user"] as const).map((layer) =>
      readLayer(layer, layerFile(layer, options.repoRoot, options.env)),
    ),
  );
  const project = await readProject(layerFile("project", options.repoRoot, options.env));
  const org = await readOrg(policy?.org ?? user?.org);

  return mergeLayers({
    defaults: await defaultConfig(),
    layers: { policy, org, user, project: project.layer },
    ignored: project.ignored,
  });
};
