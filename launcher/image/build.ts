import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { LauncherError, launcherRoot, sha256Hex, stableHash } from "../shared/index.ts";
import { placeBuildTrust } from "./build-trust.ts";
import { buildInContext, reusableImage } from "./context.ts";
import { type ExtensionsSource, PACKAGE_NAME } from "./extensions.ts";
import { type ImageRecord, isImageRecord, readImageRecord, writeImageRecord } from "./record.ts";

export interface ImageVersions {
  pi: string;
  extensions: ExtensionsSource;
}

export interface PullImageInput {
  backend: Backend;
  config: SandboxConfig;
  stateDir: string;
}

export interface EnsureImageInput extends PullImageInput {
  versions: ImageVersions;
  trustPem?: string;
  env?: Record<string, string | undefined>;
}

export interface BuiltImage {
  reference: string;
  digest: string;
  id: string;
  built: boolean;
  pi?: string;
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const DOCKERFILE = "Dockerfile";

const ENTRYPOINT = "entrypoint.sh";

const BROWSER_SHIM = "xdg-open.mjs";

const BASH_ENV_FILE = "bash-env.sh";

const COPIED_ASSETS = [ENTRYPOINT, BROWSER_SHIM, BASH_ENV_FILE];

const PINNED = "pinned";

const CONTEXT_TARBALL = "pi-extensions.tgz";

const imageAssets = () => join(launcherRoot(), "image");

const checkedVersion = (name: string, value: string) => {
  if (!VERSION_PATTERN.test(value)) {
    throw new LauncherError(`image: invalid ${name} version "${value}"`);
  }

  return value;
};

const extensionsArgument = (source: ExtensionsSource) => {
  if (source.kind === "registry") {
    return `${PACKAGE_NAME}@${checkedVersion("extensions", source.version)}`;
  }

  return source.kind === "tarball" ? CONTEXT_TARBALL : "none";
};

const pinVersions = (dockerfile: string, versions: ImageVersions) =>
  dockerfile
    .replace(/^ARG PI_VERSION$/m, `ARG PI_VERSION=${checkedVersion("pi", versions.pi)}`)
    .replace(
      /^ARG EXTENSIONS_SOURCE=none$/m,
      `ARG EXTENSIONS_SOURCE=${extensionsArgument(versions.extensions)}`,
    );

export const prepareBuildContext = async (versions: ImageVersions, dir: string, trustPem?: string) => {
  const dockerfile = await readFile(join(imageAssets(), DOCKERFILE), "utf8");

  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, DOCKERFILE), pinVersions(dockerfile, versions));

  await Promise.all(COPIED_ASSETS.map((name) => copyFile(join(imageAssets(), name), join(dir, name))));

  await placeBuildTrust(dir, trustPem);

  if (versions.extensions.kind === "tarball") {
    await copyFile(versions.extensions.path, join(dir, CONTEXT_TARBALL));
  }

  return dir;
};

const fileSha256 = async (path: string) => sha256Hex(await readFile(path));

const extensionsIdentity = async (source: ExtensionsSource) =>
  source.kind === "tarball" ? { kind: source.kind, sha256: await fileSha256(source.path) } : source;

const inputsHash = async (config: SandboxConfig, versions: ImageVersions) => {
  const assets = await Promise.all(
    [DOCKERFILE, ...COPIED_ASSETS].map((name) => readFile(join(imageAssets(), name), "utf8")),
  );
  const extensions = await extensionsIdentity(versions.extensions);

  return stableHash({ reference: config.image.reference, pi: versions.pi, extensions, assets });
};

export const recordedImage = async (stateDir: string, config: SandboxConfig) => {
  const record = await readImageRecord(stateDir);
  const { reference, digest } = config.image;

  if (!isImageRecord(record) || record.reference !== reference) {
    return undefined;
  }

  return digest === undefined || record.digest === digest ? record : undefined;
};

const reusableBuild = (backend: Backend, record: ImageRecord | undefined, hash: string) =>
  record === undefined || record.inputsHash !== hash
    ? undefined
    : reusableImage(backend, record.reference, record.digest);

const buildLocally = async (input: EnsureImageInput, hash: string): Promise<BuiltImage> => {
  const reference = input.config.image.reference;
  const { id, digest } = await buildInContext(input, {
    prefix: "build",
    tag: reference,
    fill: (dir) => prepareBuildContext(input.versions, dir, input.trustPem),
  });

  await writeImageRecord(input.stateDir, { reference, digest, id, inputsHash: hash, pi: input.versions.pi });

  return { reference, digest, id, built: true, pi: input.versions.pi };
};

export const pullPinnedImage = async (input: PullImageInput, pinned: string): Promise<BuiltImage> => {
  const reference = input.config.image.reference;
  const { id, digest } = await input.backend.pullImage(reference, pinned);

  if (digest !== pinned) {
    throw new LauncherError(`image ${reference} has digest ${digest}, expected ${pinned}`);
  }

  await writeImageRecord(input.stateDir, { reference, digest, id, inputsHash: PINNED });

  return { reference, digest, id, built: false };
};

export const ensureBuiltImage = async (input: EnsureImageInput): Promise<BuiltImage> => {
  const pinned = input.config.image.digest;

  if (pinned !== undefined) {
    return pullPinnedImage(input, pinned);
  }

  const hash = await inputsHash(input.config, input.versions);
  const record = await recordedImage(input.stateDir, input.config);
  const reused = await reusableBuild(input.backend, record, hash);

  if (reused === undefined || record === undefined) {
    return buildLocally(input, hash);
  }

  if (record.pi !== input.versions.pi) {
    await writeImageRecord(input.stateDir, { ...record, pi: input.versions.pi });
  }

  return {
    reference: input.config.image.reference,
    digest: reused.digest,
    id: reused.id,
    built: false,
    pi: input.versions.pi,
  };
};
