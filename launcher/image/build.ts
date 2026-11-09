import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { LauncherError, launcherRoot, stableHash } from "../shared/index.ts";
import { placeBuildTrust } from "./build-trust.ts";
import { buildInContext, reusableImage } from "./context.ts";
import { type BaseRecord, readBaseRecord, writeBaseRecord } from "./record.ts";

export interface ImageVersions {
  pi: string;
}

export interface PullImageInput {
  backend: Backend;
  config: SandboxConfig;
  stateDir: string;
  preparing?: () => void;
}

export interface EnsureImageInput extends PullImageInput {
  versions: ImageVersions;
  trustPem?: string;
  proxyCaPem?: string;
  env?: Record<string, string | undefined>;
}

export interface BuiltImage {
  reference: string;
  digest: string;
  id: string;
  built: boolean;
  pi?: string;
  replaced?: string;
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const DOCKERFILE = "Dockerfile";

const ENTRYPOINT = "entrypoint.sh";

const BASH_ENV_FILE = "bash-env.sh";

const COPIED_ASSETS = [ENTRYPOINT, BASH_ENV_FILE];

const PINNED = "pinned";

const PROXY_CA_FILE = "proxy-ca.pem";

interface BuildTrust {
  trustPem?: string;
  proxyCaPem?: string;
}

const proxyCaText = (path: string | undefined) =>
  path === undefined ? Promise.resolve("") : readFile(path, "utf8");

const imageAssets = () => join(launcherRoot(), "image");

const checkedVersion = (name: string, value: string) => {
  if (!VERSION_PATTERN.test(value)) {
    throw new LauncherError(`image: invalid ${name} version "${value}"`);
  }

  return value;
};

const pinVersions = (dockerfile: string, versions: ImageVersions) =>
  dockerfile.replace(/^ARG PI_VERSION$/m, `ARG PI_VERSION=${checkedVersion("pi", versions.pi)}`);

export const prepareBuildContext = async (versions: ImageVersions, dir: string, trust: BuildTrust = {}) => {
  const dockerfile = await readFile(join(imageAssets(), DOCKERFILE), "utf8");

  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, DOCKERFILE), pinVersions(dockerfile, versions));

  await Promise.all(COPIED_ASSETS.map((name) => copyFile(join(imageAssets(), name), join(dir, name))));

  await writeFile(join(dir, PROXY_CA_FILE), await proxyCaText(trust.proxyCaPem));

  await placeBuildTrust(dir, trust.trustPem);

  return dir;
};

const inputsHash = async (input: EnsureImageInput) => {
  const assets = await Promise.all(
    [DOCKERFILE, ...COPIED_ASSETS].map((name) => readFile(join(imageAssets(), name), "utf8")),
  );
  const proxyCa = await proxyCaText(input.proxyCaPem);

  return stableHash({ reference: input.config.image.reference, pi: input.versions.pi, assets, proxyCa });
};

export const recordedImage = async (stateDir: string, config: SandboxConfig) => {
  const base = await readBaseRecord(stateDir);
  const { reference, digest } = config.image;

  if (base === undefined || (digest !== undefined && base.digest !== digest)) {
    return undefined;
  }

  return { reference, ...base };
};

const reusableBuild = (backend: Backend, reference: string, base: BaseRecord | undefined, hash: string) =>
  base === undefined || base.inputsHash !== hash ? undefined : reusableImage(backend, reference, base.digest);

const replaceBase = async (stateDir: string, base: BaseRecord) => {
  const previous = await readBaseRecord(stateDir);

  await writeBaseRecord(stateDir, base);

  return previous === undefined || previous.id === base.id ? {} : { replaced: previous.id };
};

const buildLocally = async (input: EnsureImageInput, hash: string): Promise<BuiltImage> => {
  const reference = input.config.image.reference;

  input.preparing?.();

  const { id, digest } = await buildInContext(input, {
    prefix: "build",
    tag: reference,
    fill: (dir) =>
      prepareBuildContext(input.versions, dir, { trustPem: input.trustPem, proxyCaPem: input.proxyCaPem }),
  });
  const replaced = await replaceBase(input.stateDir, { id, digest, inputsHash: hash, pi: input.versions.pi });

  return { reference, digest, id, built: true, pi: input.versions.pi, ...replaced };
};

const pulledImage = async (input: PullImageInput, pinned: string) => {
  const reference = input.config.image.reference;
  const local = await reusableImage(input.backend, reference, pinned);

  if (local !== undefined) {
    return local;
  }

  input.preparing?.();

  return input.backend.pullImage(reference, pinned);
};

export const pullPinnedImage = async (input: PullImageInput, pinned: string): Promise<BuiltImage> => {
  const reference = input.config.image.reference;
  const { id, digest } = await pulledImage(input, pinned);

  if (digest !== pinned) {
    throw new LauncherError(`image ${reference} has digest ${digest}, expected ${pinned}`);
  }

  const replaced = await replaceBase(input.stateDir, { id, digest, inputsHash: PINNED });

  return { reference, digest, id, built: false, ...replaced };
};

export const ensureBuiltImage = async (input: EnsureImageInput): Promise<BuiltImage> => {
  const pinned = input.config.image.digest;

  if (pinned !== undefined) {
    return pullPinnedImage(input, pinned);
  }

  const hash = await inputsHash(input);
  const base = await readBaseRecord(input.stateDir);
  const reused = await reusableBuild(input.backend, input.config.image.reference, base, hash);

  if (reused === undefined || base === undefined) {
    return buildLocally(input, hash);
  }

  if (base.pi !== input.versions.pi) {
    await writeBaseRecord(input.stateDir, { ...base, pi: input.versions.pi });
  }

  return {
    reference: input.config.image.reference,
    digest: reused.digest,
    id: reused.id,
    built: false,
    pi: input.versions.pi,
  };
};
