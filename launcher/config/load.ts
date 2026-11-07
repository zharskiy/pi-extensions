import {
  errorMessage,
  LauncherError,
  launcherPaths,
  projectConfigFile,
  readJsonFile,
} from "../shared/index.ts";
import { defaultConfig } from "./defaults.ts";
import { mergeLayers, resolveProfileName } from "./merge.ts";
import { httpsFetchText, loadOrgLayer } from "./org-source.ts";
import { loadProfile } from "./profiles.ts";
import { capManualRules } from "./rule-cap.ts";
import type { EffectiveConfig, FetchText, LayerConfig, LayerName, OrgRef } from "./types.ts";
import { projectKeyRefusal, validateLayer } from "./validate.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

interface LoadOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  fetchText?: FetchText;
  now?: () => number;
  home?: string;
  offline?: boolean;
}

export const layerFile = (layer: LayerName, repoRoot: string, env?: NodeJS.ProcessEnv) => {
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
        home: options.home,
        offline: options.offline,
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
