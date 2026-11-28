import { rm } from "node:fs/promises";
import { type Backend, pinnedImageOf } from "../backend/index.ts";
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
  const { reference } = input.config.image;

  if (reference === undefined) {
    return ensureBuiltImage({ ...input, versions: await input.versions(), trustPem });
  }

  const pinned = pinnedImageOf(reference);

  return pullPinnedImage(input, pinned.name, pinned.digest);
};

const announcedOnce = (preparing: (() => void) | undefined) => {
  const state = { announced: false };

  return () => {
    if (state.announced) {
      return;
    }

    state.announced = true;

    preparing?.();
  };
};

const preparedImage = async (input: SandboxImageInput): Promise<SandboxImage> => {
  const trustPem = input.config.tls.extraCa.length === 0 ? undefined : input.trustPem;
  const preparing = announcedOnce(input.preparing);
  const base = await baseImage({ ...input, preparing }, trustPem);
  const layer = await ensureLayerImage({
    backend: input.backend,
    baseImageId: base.id,
    config: input.config,
    stateDir: input.stateDir,
    trustPem,
    proxyCaPem: input.proxyCaPem,
    env: input.env,
    preparing,
    progress: input.progress,
  });

  if (base.built || layer.built || base.replaced !== undefined) {
    await removeStaleImages(input.backend, input.stateDir, base.replaced).catch(() => undefined);
  }

  return { reference: base.reference, digest: base.digest, id: layer.id };
};

export const ensureSandboxImage = (input: SandboxImageInput): Promise<SandboxImage> =>
  withFileLock(stateLayout(input.stateDir).buildLock, () => preparedImage(input), {
    timeoutMs: BUILD_LOCK_TIMEOUT_MS,
    onWait: input.waiting,
  });

export const removeBuildLeftovers = (stateDir: string) =>
  withFileLockIfFree(stateLayout(stateDir).buildLock, () =>
    rm(stateLayout(stateDir).build, { recursive: true, force: true }),
  );
