import { randomBytes } from "node:crypto";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, ImageInfo } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { launcherRoot, stateLayout } from "../shared/index.ts";
import { buildProxyArgs } from "./build-proxy.ts";

export interface BuildContextInput {
  backend: Backend;
  config: SandboxConfig;
  stateDir: string;
  env?: Record<string, string | undefined>;
  progress?: (step: string) => void;
}

export const imageAsset = (name: string) => join(launcherRoot(), "image", name);

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
  build: {
    prefix: string;
    tag: string;
    args?: Record<string, string>;
    offline?: boolean;
    fill: (dir: string) => Promise<unknown>;
  },
) => {
  const contextDir = stateLayout(input.stateDir).buildContext(
    `${build.prefix}-${randomBytes(4).toString("hex")}`,
  );

  try {
    await mkdir(contextDir, { recursive: true });

    await build.fill(contextDir);

    const args = { ...buildProxyArgs(input.env ?? {}), ...build.args };

    return await input.backend.buildImage(contextDir, build.tag, {
      args,
      progress: input.progress,
      offline: build.offline,
    });
  } finally {
    await rm(contextDir, { recursive: true, force: true });

    await rmdir(stateLayout(input.stateDir).build).catch(() => undefined);
  }
};
