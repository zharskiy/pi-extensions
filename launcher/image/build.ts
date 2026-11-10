import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { errorMessage, LauncherError, launcherRoot, stableHash } from "../shared/index.ts";
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
  progress?: (step: string) => void;
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
  replaced?: string;
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export const BASE_TAG = "pi-sandbox-base:local";

const DOCKERFILE = "Dockerfile";

const COPIED_ASSETS = [DOCKERFILE, "entrypoint.sh", "bash-env.sh"];

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

const buildArgsFor = (versions: ImageVersions) => ({ PI_VERSION: checkedVersion("pi", versions.pi) });

export const prepareBuildContext = async (dir: string, trust: BuildTrust = {}) => {
  await mkdir(dir, { recursive: true });

  await Promise.all(COPIED_ASSETS.map((name) => copyFile(join(imageAssets(), name), join(dir, name))));

  await writeFile(join(dir, PROXY_CA_FILE), await proxyCaText(trust.proxyCaPem));

  await placeBuildTrust(dir, trust.trustPem);

  return dir;
};

const inputsHash = async (input: EnsureImageInput) => {
  const assets = await Promise.all(COPIED_ASSETS.map((name) => readFile(join(imageAssets(), name), "utf8")));
  const proxyCa = await proxyCaText(input.proxyCaPem);

  return stableHash({ pi: input.versions.pi, assets, proxyCa });
};

export const recordedImage = async (stateDir: string, config: SandboxConfig) => {
  const base = await readBaseRecord(stateDir);
  const { reference = BASE_TAG, digest } = config.image;
  const current = digest === undefined ? base?.inputsHash !== PINNED : base?.digest === digest;

  return base === undefined || !current ? undefined : { reference, ...base };
};

const reusableBuild = (backend: Backend, base: BaseRecord | undefined, hash: string) =>
  base === undefined || base.inputsHash !== hash ? undefined : reusableImage(backend, BASE_TAG, base.digest);

const replaceBase = async (stateDir: string, base: BaseRecord) => {
  const previous = await readBaseRecord(stateDir);

  await writeBaseRecord(stateDir, base);

  return previous === undefined || previous.id === base.id ? {} : { replaced: previous.id };
};

const announced = <T>(input: PullImageInput, action: () => Promise<T>) => {
  input.preparing?.();

  return action();
};

const unpublishedPi = (version: string) => (error: unknown) => {
  const message = errorMessage(error);

  throw message.includes(`No matching version found for ${PI_PACKAGE}@${version}`)
    ? new LauncherError(
        message,
        `the host pi is version ${version}, which the npm registry does not have; install a published pi on the host`,
      )
    : error;
};

const buildLocally = async (input: EnsureImageInput, hash: string): Promise<BuiltImage> => {
  const { id, digest } = await announced(input, () =>
    buildInContext(input, {
      prefix: "build",
      tag: BASE_TAG,
      args: buildArgsFor(input.versions),
      fill: (dir) => prepareBuildContext(dir, { trustPem: input.trustPem, proxyCaPem: input.proxyCaPem }),
    }).catch(unpublishedPi(input.versions.pi)),
  );
  const replaced = await replaceBase(input.stateDir, { id, digest, inputsHash: hash });

  return { reference: BASE_TAG, digest, id, built: true, ...replaced };
};

const pulledImage = async (input: PullImageInput, reference: string, pinned: string) => {
  const local = await reusableImage(input.backend, reference, pinned);

  if (local !== undefined) {
    return local;
  }

  return announced(input, () => input.backend.pullImage(reference, pinned));
};

export const pullPinnedImage = async (
  input: PullImageInput,
  reference: string,
  pinned: string,
): Promise<BuiltImage> => {
  const { id, digest } = await pulledImage(input, reference, pinned);

  if (digest !== pinned) {
    throw new LauncherError(`image ${reference} has digest ${digest}, expected ${pinned}`);
  }

  const replaced = await replaceBase(input.stateDir, { id, digest, inputsHash: PINNED });

  return { reference, digest, id, built: false, ...replaced };
};

export const ensureBuiltImage = async (input: EnsureImageInput): Promise<BuiltImage> => {
  const hash = await inputsHash(input);
  const base = await readBaseRecord(input.stateDir);
  const reused = await reusableBuild(input.backend, base, hash);

  if (reused === undefined || base === undefined) {
    return buildLocally(input, hash);
  }

  return { reference: BASE_TAG, digest: reused.digest, id: reused.id, built: false };
};
