import { mkdir, rm, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import {
  type CommandRunner,
  LauncherError,
  readJsonFile,
  readJsonObject,
  stateLayout,
  writeJsonFile,
} from "../shared/index.ts";

export type ExtensionsSource =
  | { kind: "registry"; version: string }
  | { kind: "tarball"; path: string }
  | { kind: "none" };

export interface PackInput {
  packageDir: string;
  runner: CommandRunner;
  outDir: string;
}

export interface ResolveExtensionsInput {
  launcherRoot: string;
  runner: CommandRunner;
  stateDir: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
}

interface PackRecord {
  version: string;
  head: string;
  path: string;
}

export const PACKAGE_NAME = "pi-extensions-mz";

const INERT_GIT = ["-c", "core.fsmonitor=false"];

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const packedFile = (stdout: string) => stdout.trim().split("\n").at(-1)?.trim() ?? "";

export const packExtensionsTarball = async ({ packageDir, runner, outDir }: PackInput) => {
  await mkdir(outDir, { recursive: true });

  const result = await runner.run("npm", ["pack", "--pack-destination", outDir, packageDir]);
  const file = packedFile(result.stdout);

  if (result.code !== 0 || !file.endsWith(".tgz")) {
    throw new LauncherError(
      `npm pack ${packageDir} failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
    );
  }

  return join(outDir, basename(file));
};

const isInstalledCopy = (packageDir: string) => packageDir.split(sep).includes("node_modules");

const gitOutput = async (runner: CommandRunner, packageDir: string, args: string[]) => {
  const result = await runner.run("git", [...INERT_GIT, ...args], { cwd: packageDir }).catch(() => undefined);

  return result?.code === 0 ? result.stdout : undefined;
};

const cleanCheckoutHead = async (runner: CommandRunner, packageDir: string) => {
  const [head, status] = await Promise.all([
    gitOutput(runner, packageDir, ["rev-parse", "HEAD"]),
    gitOutput(runner, packageDir, ["status", "--porcelain", "-z"]),
  ]);
  const commit = head?.trim() ?? "";

  return commit !== "" && status === "" ? commit : undefined;
};

const cachedTarball = async (record: Partial<PackRecord> | undefined, version: string, head: string) =>
  record?.version === version &&
  record.head === head &&
  typeof record.path === "string" &&
  (await exists(record.path))
    ? record.path
    : undefined;

const packedSource = async (packageDir: string, version: string, input: ResolveExtensionsInput) => {
  const outDir = stateLayout(input.stateDir).pack;
  const recordFile = join(outDir, "pack.json");
  const head = await cleanCheckoutHead(input.runner, packageDir);

  if (head === undefined) {
    await rm(recordFile, { force: true });

    return packExtensionsTarball({ packageDir, runner: input.runner, outDir });
  }

  const record: Partial<PackRecord> | undefined = await readJsonObject(recordFile);
  const cached = await cachedTarball(record, version, head);

  if (cached !== undefined) {
    return cached;
  }

  const path = await packExtensionsTarball({ packageDir, runner: input.runner, outDir });

  await writeJsonFile(recordFile, { version, head, path } satisfies PackRecord);

  return path;
};

export const resolveExtensionsSource = async (input: ResolveExtensionsInput): Promise<ExtensionsSource> => {
  const packageDir = join(input.launcherRoot, "..");
  const manifest = await readJsonFile<PackageManifest>(join(packageDir, "package.json"));

  if (manifest?.name !== PACKAGE_NAME || manifest.version === undefined) {
    throw new LauncherError(`${packageDir}: not the ${PACKAGE_NAME} package`, "reinstall the launcher");
  }

  if (isInstalledCopy(packageDir)) {
    return { kind: "registry", version: manifest.version };
  }

  return { kind: "tarball", path: await packedSource(packageDir, manifest.version, input) };
};
