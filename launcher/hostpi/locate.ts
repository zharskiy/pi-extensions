import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isJsonObject, launcherRoot, readJsonObject } from "../shared/index.ts";
import { isExecutable } from "./path-search.ts";
import type { BundledPi, HostPi } from "./types.ts";

interface PiManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const PI_BIN = "pi";

const MANAGED_KIND = "pi-managed-install";

const MANAGED_SCHEMA = 1;

const MANAGED_LAYOUT = "releases-v1";

export const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const packageDirFrom = (start: string, stop: string): string | undefined => {
  const candidate = join(start, "node_modules", PI_PACKAGE);

  if (existsSync(join(candidate, "package.json"))) {
    return candidate;
  }

  const parent = dirname(start);

  return start === stop || parent === start ? undefined : packageDirFrom(parent, stop);
};

const binOf = (manifest: PiManifest) => {
  if (typeof manifest.bin === "string") {
    return manifest.bin;
  }

  const named = isJsonObject(manifest.bin) ? manifest.bin[PI_BIN] : undefined;

  return typeof named === "string" ? named : undefined;
};

const manifestOf = async (packageDir: string): Promise<PiManifest> =>
  (await readJsonObject(join(packageDir, "package.json"))) ?? {};

export const locateBundledPi = async (root = launcherRoot()): Promise<BundledPi | undefined> => {
  const packageDir = packageDirFrom(root, dirname(root));

  if (packageDir === undefined) {
    return undefined;
  }

  const manifest = await manifestOf(packageDir);
  const bin = binOf(manifest);

  if (typeof manifest.version !== "string" || bin === undefined) {
    return undefined;
  }

  return { command: [process.execPath, join(packageDir, bin)], version: manifest.version, packageDir };
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
  const manifest = await manifestOf(packageDir);
  const bin = binOf(manifest);
  const wrapper = join(agentDir, "bin", PI_BIN);

  if (typeof manifest.version !== "string" || bin === undefined || !(await isExecutable(wrapper))) {
    return undefined;
  }

  return {
    command: [process.execPath, join(packageDir, bin)],
    version: manifest.version,
    packageDir,
    source: "managed",
    wrapper,
  };
};

const packageAbove = async (dir: string): Promise<{ dir: string; version: string } | undefined> => {
  const { name, version } = await manifestOf(dir);

  if (name === PI_PACKAGE && typeof version === "string") {
    return { dir, version };
  }

  const parent = dirname(dir);

  return parent === dir ? undefined : packageAbove(parent);
};

export const locatePiPackage = async (binPath: string): Promise<HostPi | undefined> => {
  const real = await realpath(binPath).catch(() => undefined);
  const found = real === undefined ? undefined : await packageAbove(dirname(real));

  return found === undefined
    ? undefined
    : { command: [binPath], version: found.version, packageDir: found.dir, source: "path" };
};
