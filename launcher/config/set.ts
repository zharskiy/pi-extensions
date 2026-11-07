import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LauncherError,
  launcherPaths,
  readJsonFile,
  sha256Hex,
  withFileLock,
  writeJsonFile,
} from "../shared/index.ts";
import { isRecord, setPath } from "./dotted.ts";
import { layerFile, loadOrg, readLayer, resolveConfig, validateLayerFile } from "./load.ts";
import { layerKeys } from "./validate.ts";

interface SetConfigOptions {
  layer: "user" | "project";
  key: string;
  value: unknown;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
}

const settableKeys = () => layerKeys().filter((key) => key !== "$schema" && !key.includes("[]"));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const prepareProjectFolder = async (file: string) => {
  const folder = dirname(file);

  if (await exists(folder)) {
    return;
  }

  await mkdir(folder, { recursive: true });

  await writeFile(join(folder, ".gitignore"), "*\n", { flag: "wx" });
};

const lockOf = (file: string, env: NodeJS.ProcessEnv | undefined) =>
  join(launcherPaths({ env }).stateDir, "locks", `config-${sha256Hex(file).slice(0, 16)}`);

const writeValue = async ({ layer, key, value, env }: SetConfigOptions, root: string, file: string) => {
  const current = (await readJsonFile<unknown>(file)) ?? {};

  if (!isRecord(current)) {
    throw new LauncherError(`${layer}: must be a JSON object`, `fix ${file}`);
  }

  const updated = setPath(current, key, value);
  const policy = await readLayer("policy", layerFile("policy", root, env));
  const user =
    layer === "user"
      ? validateLayerFile(updated, layer, file)
      : await readLayer("user", layerFile("user", root, env));
  const project = layer === "project" ? validateLayerFile(updated, layer, file) : undefined;

  const org = await loadOrg(policy?.org ?? user?.org, { repoRoot: root, env });

  await resolveConfig({ policy, org: org.layer, user, project });

  if (layer === "project") {
    await prepareProjectFolder(file);
  }

  await writeJsonFile(file, updated);

  return { file };
};

export const setConfigValue = async (options: SetConfigOptions) => {
  const { layer, key, repoRoot, env } = options;

  if (layer === "project" && repoRoot === undefined) {
    throw new LauncherError("project: no repository root to write .pi/sandbox.json in");
  }

  if (!settableKeys().includes(key)) {
    throw new LauncherError(`${layer}: ${key} is not a known key`);
  }

  const root = repoRoot ?? process.cwd();
  const file = layerFile(layer, root, env);

  return withFileLock(lockOf(file, env), () => writeValue(options, root, file), { timeoutMs: 10_000 });
};
