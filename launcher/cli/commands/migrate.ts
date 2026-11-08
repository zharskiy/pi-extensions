import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../../backend/index.ts";
import { setConfigValue } from "../../config/index.ts";
import { removeRepoContainer, repoVolumes } from "../../container/index.ts";
import { recordedImage } from "../../image/index.ts";
import { BACKEND_NAMES, type BackendName, LauncherError } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { type LaunchContext, openAdminContext, openBackend, prepareImage } from "../launch.ts";

const targetName = (args: string[]) => {
  const [flag, name, ...extra] = args;
  const target = BACKEND_NAMES.find((candidate) => candidate === name);

  if (flag !== "--to" || target === undefined || extra.length > 0) {
    throw new LauncherError(`usage: pi sandbox migrate --to <${BACKEND_NAMES.join("|")}>`);
  }

  return target;
};

const availableTarget = async (deps: CliDeps, name: BackendName) => {
  const target = deps.adapters().find((adapter) => adapter.name === name);

  if (target === undefined) {
    throw new LauncherError(`migrate: no ${name} adapter on this host`);
  }

  const detection = await target.detect();

  if (!detection.available) {
    throw new LauncherError(`migrate: ${name} is not available: ${detection.reason ?? "unknown reason"}`);
  }

  return target;
};

interface MigrationSide {
  backend: Backend;
  imageId: string;
}

const helperImageId = async (deps: CliDeps, context: LaunchContext, backend: Backend) => {
  const record = await recordedImage(context.stateDir, context.effective.config);
  const local =
    record === undefined ? undefined : await backend.resolveImage(record.id).catch(() => undefined);

  return local?.id ?? (await prepareImage(deps, context, backend)).id;
};

const moveVolume = async (source: MigrationSide, target: MigrationSide, name: string, directory: string) => {
  const archive = join(directory, `${name}.tar`);

  await source.backend.ensureVolume(name);

  await source.backend.exportVolume(name, archive, source.imageId);

  const listed = (await source.backend.listVolumes()).find((volume) => volume.name === name);

  await target.backend.ensureVolume(name, listed?.labels);

  await target.backend.importVolume(name, archive, target.imageId);

  return archive;
};

const moveVolumes = (source: MigrationSide, target: MigrationSide, names: string[], directory: string) =>
  names.reduce<Promise<string[]>>(
    async (moved, name) => [...(await moved), await moveVolume(source, target, name, directory)],
    Promise.resolve([]),
  );

export const migrateCommand = async (deps: CliDeps, args: string[]) => {
  const name = targetName(args);
  const context = await openAdminContext(deps);

  if (context.effective.sources.backend === "policy") {
    throw new LauncherError("migrate: backend is set by policy and cannot change");
  }

  const source = await openBackend(deps, context.effective.config);

  if (source.name === name) {
    throw new LauncherError(`migrate: already on ${name}`);
  }

  const target = await availableTarget(deps, name);
  const directory = join(context.stateDir, "migrate", String(deps.now()));

  await mkdir(directory, { recursive: true });

  const volumes = repoVolumes({
    workspace: context.workspace,
    config: context.effective.config,
    hostEnv: deps.env,
    uid: deps.uid,
  });
  const from = { backend: source, imageId: await helperImageId(deps, context, source) };
  const to = { backend: target, imageId: await helperImageId(deps, context, target) };
  const archives = await moveVolumes(from, to, volumes, directory);

  writeLines(
    deps.stdout,
    archives.map((archive) => `moved ${archive}`),
  );

  const { file } = await setConfigValue({
    layer: "user",
    key: "backend",
    value: name,
    repoRoot: context.workspace.repoRoot,
    env: deps.env,
  });

  writeLine(deps.stdout, `set backend to ${name} in ${file}`);

  const removed = await removeRepoContainer(source, context.workspace.repoRoot);

  writeLines(
    deps.stdout,
    removed.map((container) => `removed ${source.name} container ${container.name}`),
  );

  return 0;
};
