import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { LauncherError, launcherRoot, readJsonFile, sha256Hex, writeJsonFile } from "../shared/index.ts";
import type { ExtensionsSource } from "./extensions.ts";
import { renderAuthJson, renderModelsJson } from "./render.ts";

export interface ImageVersions {
  pi: string;
  extensions: ExtensionsSource;
}

export interface EnsureImageInput {
  backend: Backend;
  config: SandboxConfig;
  versions: ImageVersions;
  stateDir: string;
}

export interface ImageRecord {
  reference: string;
  digest: string;
  id: string;
  inputsHash: string;
}

export interface BuiltImage {
  reference: string;
  digest: string;
  id: string;
  built: boolean;
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const DOCKERFILE = "Dockerfile";

const ENTRYPOINT = "entrypoint.sh";

const PACKAGE_NAME = "pi-extensions-mz";

const RECORD_FILE = "image.json";

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

const renderedFiles = (config: SandboxConfig) => ({
  "models.json": `${JSON.stringify(renderModelsJson(config.gateway), null, 2)}\n`,
  "auth.json": `${JSON.stringify(renderAuthJson(config.gateway), null, 2)}\n`,
});

export const prepareBuildContext = async (config: SandboxConfig, versions: ImageVersions, dir: string) => {
  const dockerfile = await readFile(join(imageAssets(), DOCKERFILE), "utf8");

  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, DOCKERFILE), pinVersions(dockerfile, versions));

  await copyFile(join(imageAssets(), ENTRYPOINT), join(dir, ENTRYPOINT));

  await Promise.all(
    Object.entries(renderedFiles(config)).map(([name, text]) => writeFile(join(dir, name), text)),
  );

  if (versions.extensions.kind === "tarball") {
    await copyFile(versions.extensions.path, join(dir, CONTEXT_TARBALL));
  }

  return dir;
};

const fileSha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const extensionsIdentity = async (source: ExtensionsSource) =>
  source.kind === "tarball" ? { kind: source.kind, sha256: await fileSha256(source.path) } : source;

const inputsHash = async (config: SandboxConfig, versions: ImageVersions) => {
  const assets = await Promise.all(
    [DOCKERFILE, ENTRYPOINT].map((name) => readFile(join(imageAssets(), name), "utf8")),
  );
  const extensions = await extensionsIdentity(versions.extensions);

  return sha256Hex(
    JSON.stringify({
      reference: config.image.reference,
      pi: versions.pi,
      extensions,
      assets,
      files: renderedFiles(config),
    }),
  );
};

const recordFileOf = (stateDir: string) => join(stateDir, RECORD_FILE);

const readRecord = (stateDir: string) =>
  readJsonFile<Partial<ImageRecord>>(recordFileOf(stateDir)).catch(() => undefined);

const isRecord = (record: Partial<ImageRecord> | undefined): record is ImageRecord =>
  typeof record?.reference === "string" &&
  typeof record.digest === "string" &&
  typeof record.id === "string" &&
  typeof record.inputsHash === "string";

export const recordedImage = async (stateDir: string, config: SandboxConfig) => {
  const record = await readRecord(stateDir);
  const { reference, digest } = config.image;

  if (!isRecord(record) || record.reference !== reference) {
    return undefined;
  }

  return digest === undefined || record.digest === digest ? record : undefined;
};

const reusableBuild = async (backend: Backend, record: ImageRecord | undefined, hash: string) => {
  if (record === undefined || record.inputsHash !== hash) {
    return undefined;
  }

  const local = await backend.resolveImage(record.reference).catch(() => undefined);

  return local?.digest === record.digest ? local : undefined;
};

const buildLocally = async (input: EnsureImageInput, hash: string): Promise<BuiltImage> => {
  const reference = input.config.image.reference;
  const contextDir = join(input.stateDir, `build-${randomBytes(4).toString("hex")}`);

  try {
    await prepareBuildContext(input.config, input.versions, contextDir);

    const { id, digest } = await input.backend.buildImage(contextDir, reference);

    await writeJsonFile(recordFileOf(input.stateDir), {
      reference,
      digest,
      id,
      inputsHash: hash,
    } satisfies ImageRecord);

    return { reference, digest, id, built: true };
  } finally {
    await rm(contextDir, { recursive: true, force: true });
  }
};

const pullPinned = async (input: EnsureImageInput, pinned: string): Promise<BuiltImage> => {
  const reference = input.config.image.reference;
  const { id, digest } = await input.backend.pullImage(reference, pinned);

  if (digest !== pinned) {
    throw new LauncherError(`image ${reference} has digest ${digest}, expected ${pinned}`);
  }

  await writeJsonFile(recordFileOf(input.stateDir), {
    reference,
    digest,
    id,
    inputsHash: PINNED,
  } satisfies ImageRecord);

  return { reference, digest, id, built: false };
};

export const ensureBuiltImage = async (input: EnsureImageInput): Promise<BuiltImage> => {
  const pinned = input.config.image.digest;

  if (pinned !== undefined) {
    return pullPinned(input, pinned);
  }

  const hash = await inputsHash(input.config, input.versions);
  const record = await recordedImage(input.stateDir, input.config);
  const reused = await reusableBuild(input.backend, record, hash);

  return reused === undefined
    ? buildLocally(input, hash)
    : { reference: input.config.image.reference, digest: reused.digest, id: reused.id, built: false };
};
