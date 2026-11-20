import { readFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type CommandRunner,
  isJsonObject,
  isWithin,
  readJsonObject,
  realOrResolved,
} from "../shared/index.ts";
import { findOnPath, isExecutable } from "./path-search.ts";
import type { HostPi } from "./types.ts";

interface PiManifest {
  version?: unknown;
  bin?: unknown;
}

interface NpmPiInput {
  runner: CommandRunner;
  env: Record<string, string | undefined>;
  home: string;
  accept: (path: string, real: string) => Promise<boolean>;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const PI_BIN = "pi";

const MANAGED_KIND = "pi-managed-install";

const MANAGED_SCHEMA = 1;

const MANAGED_LAYOUT = "releases-v1";

const NPM_TIMEOUT_MS = 10_000;

export const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const binOf = (manifest: PiManifest) => {
  if (typeof manifest.bin === "string") {
    return manifest.bin;
  }

  const named = isJsonObject(manifest.bin) ? manifest.bin[PI_BIN] : undefined;

  return typeof named === "string" ? named : undefined;
};

const piPackageAt = async (packageDir: string) => {
  const manifest: PiManifest = (await readJsonObject(join(packageDir, "package.json"))) ?? {};
  const bin = binOf(manifest);

  if (typeof manifest.version !== "string" || !SAFE_VERSION.test(manifest.version) || bin === undefined) {
    return undefined;
  }

  const entry = resolve(packageDir, bin);

  return entry !== packageDir && isWithin(entry, packageDir)
    ? { version: manifest.version, entry }
    : undefined;
};

const isManagedMarker = (marker: unknown) =>
  isJsonObject(marker) &&
  marker.kind === MANAGED_KIND &&
  marker.schemaVersion === MANAGED_SCHEMA &&
  marker.layout === MANAGED_LAYOUT;

const currentRelease = async (installDir: string) => {
  const text = await readFile(join(installDir, "current-version"), "utf8").catch(() => "");
  const release = text.trim();

  return SAFE_VERSION.test(release) ? release : undefined;
};

export const locateManagedPi = async (agentDir: string): Promise<HostPi | undefined> => {
  const installDir = join(agentDir, "install");

  if (!isManagedMarker(await readJsonObject(join(installDir, "managed-install.json")))) {
    return undefined;
  }

  const release = await currentRelease(installDir);

  if (release === undefined) {
    return undefined;
  }

  const packageDir = join(installDir, "releases", release, "node_modules", PI_PACKAGE);
  const found = await piPackageAt(packageDir);
  const wrapper = join(agentDir, "bin", PI_BIN);

  if (found === undefined || !(await isExecutable(wrapper))) {
    return undefined;
  }

  return {
    command: [process.execPath, found.entry],
    hostJob: [wrapper],
    version: found.version,
    packageDir,
    location: wrapper,
  };
};

const npmGlobalRoot = async (input: NpmPiInput) => {
  const npm = await findOnPath(input.env, "npm", [], input.accept);

  if (npm === undefined) {
    return undefined;
  }

  const result = await input.runner
    .run(npm, ["root", "--global"], {
      cwd: input.home,
      env: { PATH: [dirname(npm), input.env.PATH ?? ""].join(delimiter) },
      timeoutMs: NPM_TIMEOUT_MS,
    })
    .catch(() => undefined);
  const root = result?.code === 0 ? result.stdout.trim() : "";

  return isAbsolute(root) && basename(root) === "node_modules" ? root : undefined;
};

const isAccepted = async (input: NpmPiInput, path: string) => input.accept(path, await realOrResolved(path));

export const locateNpmPi = async (input: NpmPiInput): Promise<HostPi | undefined> => {
  const root = await npmGlobalRoot(input);

  if (root === undefined) {
    return undefined;
  }

  const packageDir = join(root, PI_PACKAGE);
  const found = await piPackageAt(packageDir);

  if (found === undefined) {
    return undefined;
  }

  const [realRoot, realPackage, realEntry] = await Promise.all(
    [root, packageDir, found.entry].map(realOrResolved),
  );

  if (!isWithin(realPackage, realRoot) || !isWithin(realEntry, realPackage)) {
    return undefined;
  }

  const accepted = await Promise.all([packageDir, found.entry].map((path) => isAccepted(input, path)));

  if (!accepted.every(Boolean)) {
    return undefined;
  }

  const command = [process.execPath, found.entry];

  return { command, hostJob: command, version: found.version, packageDir, location: packageDir };
};
