import { join } from "node:path";
import type { HostPi } from "../hostpi/index.ts";
import { LauncherError, launcherRoot, readJsonFile } from "../shared/index.ts";

interface PackageManifest {
  version?: string;
  devDependencies?: Record<string, string>;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const readManifest = async () => {
  const file = join(launcherRoot(), "..", "package.json");
  const manifest = await readJsonFile<PackageManifest>(file);

  if (manifest?.version === undefined) {
    throw new LauncherError(`${file}: no package version`, "reinstall the launcher");
  }

  return { file, manifest, version: manifest.version };
};

export const launcherVersion = async () => (await readManifest()).version;

export const testedPiVersion = async () => {
  const { file, manifest } = await readManifest();
  const range = manifest.devDependencies?.[PI_PACKAGE];
  const version = range?.replace(/^[^0-9]*/, "");

  if (version === undefined || version === "") {
    throw new LauncherError(`${file}: no ${PI_PACKAGE} version to build the image with`);
  }

  return version;
};

export const imagePiVersion = async (pi: HostPi | undefined) => pi?.version ?? (await testedPiVersion());

const RELEASE_PARTS = 3;

const releaseParts = (version: string) =>
  Array.from(
    { length: RELEASE_PARTS },
    (_, index) => Number.parseInt(version.split(".")[index] ?? "0", 10) || 0,
  );

export const isOlderVersion = (version: string, than: string) => {
  const have = releaseParts(version);
  const want = releaseParts(than);
  const differing = have.findIndex((part, index) => part !== want[index]);

  return differing !== -1 && (have[differing] ?? 0) < (want[differing] ?? 0);
};
