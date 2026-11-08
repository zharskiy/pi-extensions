import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { ensureBuiltImage, type ImageVersions, pullPinnedImage, recordedImage } from "./build.ts";
import { ensureLayerImage } from "./layer.ts";

export interface SandboxImageInput {
  backend: Backend;
  config: SandboxConfig;
  stateDir: string;
  env?: Record<string, string | undefined>;
  trustPem?: string;
  versions: () => Promise<ImageVersions>;
  inUse: (digest: string) => Promise<boolean>;
  preparing?: () => void;
}

export interface SandboxImage {
  reference: string;
  digest: string;
  id: string;
  pi?: string;
}

const imageInUse = async (input: SandboxImageInput) => {
  const record = await recordedImage(input.stateDir, input.config);

  return record !== undefined && (await input.inUse(record.digest)) ? record : undefined;
};

const freshImage = async (input: SandboxImageInput, trustPem: string | undefined) => {
  const pinned = input.config.image.digest;

  input.preparing?.();

  if (pinned !== undefined) {
    return pullPinnedImage(input, pinned);
  }

  return ensureBuiltImage({ ...input, versions: await input.versions(), trustPem });
};

export const ensureSandboxImage = async (input: SandboxImageInput): Promise<SandboxImage> => {
  const trustPem = input.config.tls.extraCa.length === 0 ? undefined : input.trustPem;
  const base = (await imageInUse(input)) ?? (await freshImage(input, trustPem));
  const layer = await ensureLayerImage({
    backend: input.backend,
    baseImageId: base.id,
    config: input.config,
    stateDir: input.stateDir,
    trustPem,
    env: input.env,
  });

  return { reference: base.reference, digest: base.digest, id: layer.id, pi: base.pi };
};
