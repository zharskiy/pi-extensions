import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { Backend, ImageInfo } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { stateLayout } from "../shared/index.ts";
import { buildProxyArgs } from "./build-proxy.ts";

export interface BuildContextInput {
  backend: Backend;
  config: SandboxConfig;
  stateDir: string;
  env?: Record<string, string | undefined>;
  progress?: (step: string) => void;
}

export const reusableImage = async (
  backend: Backend,
  reference: string,
  digest: string,
): Promise<ImageInfo | undefined> => {
  const local = await backend.resolveImage(reference).catch(() => undefined);

  return local?.digest === digest ? local : undefined;
};

export const buildInContext = async (
  input: BuildContextInput,
  build: { prefix: string; tag: string; fill: (dir: string) => Promise<unknown> },
) => {
  const contextDir = stateLayout(input.stateDir).buildContext(
    `${build.prefix}-${randomBytes(4).toString("hex")}`,
  );

  try {
    await mkdir(contextDir, { recursive: true });

    await build.fill(contextDir);

    const buildArgs = buildProxyArgs(input.config.egress.parentProxy, input.env ?? {});

    return await input.backend.buildImage(contextDir, build.tag, buildArgs, input.progress);
  } finally {
    await rm(contextDir, { recursive: true, force: true });
  }
};
