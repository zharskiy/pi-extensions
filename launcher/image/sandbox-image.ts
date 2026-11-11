import { rm } from "node:fs/promises";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { stateLayout, withFileLock, withFileLockIfFree } from "../shared/index.ts";
import { type BuiltImage, ensureBuiltImage, type ImageVersions, pullPinnedImage } from "./build.ts";
import { ensureLayerImage } from "./layer.ts";
import { removeStaleImages } from "./prune.ts";

export interface SandboxImageInput {
  backend: Backend;
  config: SandboxConfig;
  stateDir: string;
  env?: Record<string, string | undefined>;
  trustPem?: string;
  proxyCaPem?: string;
  versions: () => Promise<ImageVersions>;
  preparing?: () => void;
  waiting?: () => void;
  progress?: (step: string) => void;
}

export interface SandboxImage {
  reference: string;
  digest: string;
  id: string;
}

const BUILD_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

const baseImage = async (input: SandboxImageInput, trustPem: string | undefined): Promise<BuiltImage> => {
  const { reference, digest } = input.config.image;

  return reference !== undefined && digest !== undefined
    ? pullPinnedImage(input, reference, digest)
    : ensureBuiltImage({ ...input, versions: await input.versions(), trustPem });
};

const preparedImage = async (input: SandboxImageInput): Promise<SandboxImage> => {
  const trustPem = input.config.tls.extraCa.length === 0 ? undefined : input.trustPem;
  const base = await baseImage(input, trustPem);
  const layer = await ensureLayerImage({
    backend: input.backend,
    baseImageId: base.id,
    config: input.config,
    stateDir: input.stateDir,
    trustPem,
    env: input.env,
    progress: input.progress,
  });

  if (base.built || layer.built || base.replaced !== undefined) {
    await removeStaleImages(input.backend, input.stateDir, base.replaced).catch(() => undefined);
  }

  return { reference: base.reference, digest: base.digest, id: layer.id };
};

export const ensureSandboxImage = async (input: SandboxImageInput): Promise<SandboxImage> => {
  const lock = stateLayout(input.stateDir).buildLock;
  const free = await withFileLockIfFree(lock, () => preparedImage(input));

  if (!free.busy) {
    return free.value;
  }

  input.waiting?.();

  return withFileLock(lock, () => preparedImage(input), { timeoutMs: BUILD_LOCK_TIMEOUT_MS });
};

export const removeBuildLeftovers = (stateDir: string) =>
  withFileLockIfFree(stateLayout(stateDir).buildLock, () =>
    rm(stateLayout(stateDir).build, { recursive: true, force: true }),
  );
