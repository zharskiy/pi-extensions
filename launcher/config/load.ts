import {
  errorMessage,
  LauncherError,
  launcherPaths,
  projectConfigFile,
  readJsonFile,
} from "../shared/index.ts";
import { defaultConfig } from "./defaults.ts";
import { getPath } from "./dotted.ts";
import { mergeLayers, resolveProfileName } from "./merge.ts";
import { httpsFetchText, loadOrgLayer } from "./org-source.ts";
import { loadProfile } from "./profiles.ts";
import { capManualRules } from "./rule-cap.ts";
import type { EffectiveConfig, FetchText, LayerConfig, LayerName, OrgRef } from "./types.ts";
import { validateLayer } from "./validate.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

interface LoadOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  fetchText?: FetchText;
  now?: () => number;
}

export const layerFile = (layer: LayerName, repoRoot: string, env?: NodeJS.ProcessEnv) => {
  if (layer === "project") {
    return projectConfigFile(repoRoot);
  }

  const paths = launcherPaths({ env });

  return layer === "policy" ? paths.policyFile : paths.userConfigFile;
};

const HOST_ONLY_KEYS = ["env.allow", "image.reference", "image.digest"];

const assertProjectKeys = (layer: LayerConfig, file: string) => {
  const key = HOST_ONLY_KEYS.find((name) => getPath(layer, name) !== undefined);

  if (key !== undefined) {
    throw new LauncherError(
      `project: ${key} may not be set by a project config (${file})`,
      `remove ${key} from ${file}; set it in the user config instead`,
    );
  }
};

const validated = (value: unknown, layer: LayerName, file: string) => {
  try {
    return validateLayer(value, layer);
  } catch (error) {
    throw new LauncherError(errorMessage(error), `fix ${file}`);
  }
};

export const validateLayerFile = (value: unknown, layer: LayerName, file: string) => {
  const config = validated(value, layer, file);

  if (layer === "project") {
    assertProjectKeys(config, file);
  }

  return config;
};

export const readLayer = async (layer: LayerName, file: string) => {
  const value = await readJsonFile<unknown>(file);

  return value === undefined ? undefined : validateLayerFile(value, layer, file);
};

export const resolveConfig = async (layers: Layers): Promise<EffectiveConfig> => {
  const profileName = resolveProfileName(layers);
  const profile = profileName === undefined ? undefined : await loadProfile(profileName);

  return mergeLayers({ defaults: await defaultConfig(), layers, profile });
};

export const loadOrg = (ref: OrgRef | undefined, options: LoadOptions) =>
  ref === undefined
    ? { layer: undefined, notices: [] }
    : loadOrgLayer({
        ref,
        stateDir: launcherPaths({ env: options.env }).stateDir,
        fetchText: options.fetchText ?? httpsFetchText,
        now: options.now ?? Date.now,
      });

export const loadEffectiveConfig = async (options: LoadOptions) => {
  const [policy, user, project] = await Promise.all(
    (["policy", "user", "project"] as const).map((layer) =>
      readLayer(layer, layerFile(layer, options.repoRoot, options.env)),
    ),
  );
  const org = await loadOrg(policy?.org ?? user?.org, options);
  const layers = { policy, org: org.layer, user, project };
  const capped = capManualRules(await resolveConfig(layers), layers);

  return { ...capped.effective, notices: [...org.notices, ...capped.notices] };
};
