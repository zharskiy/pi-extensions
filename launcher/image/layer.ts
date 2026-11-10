import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { errorMessage, expandHome, LauncherError, sha256Hex, shortHash } from "../shared/index.ts";
import { placeBuildTrust, TRUST_FILE } from "./build-trust.ts";
import { buildInContext } from "./context.ts";
import { writeWantedLayer } from "./record.ts";

interface EnsureLayerInput {
  backend: Backend;
  baseImageId: string;
  config: SandboxConfig;
  stateDir: string;
  repoHash: string;
  trustPem?: string;
  env?: Record<string, string | undefined>;
  progress?: (step: string) => void;
}

interface LayerImage {
  id: string;
  digest?: string;
  tag?: string;
  built: boolean;
}

export const LAYER_TAG_PREFIX = "pi-sandbox-layer:";

const BUILD_CRT = "/usr/local/share/ca-certificates/pi-sandbox-build.crt";

const ENTRYPOINT = "/usr/local/bin/pi-sandbox-entrypoint";

const userDockerfile = async (path: string | undefined, home: string | undefined) => {
  if (path === undefined) {
    return undefined;
  }

  const text = await readFile(expandHome(path, home), "utf8").catch((error: unknown) => {
    throw new LauncherError(`image.dockerfile: cannot read ${path}: ${errorMessage(error)}`);
  });

  return text.trimEnd();
};

const sortedUnique = (entries: string[] = []) => [...new Set(entries)].sort();

const aptStep = (packages: string[]) =>
  packages.length === 0
    ? []
    : [
        `RUN apt-get update \\\n && apt-get install -y --no-install-recommends ${packages.join(" ")} \\\n && rm -rf /var/lib/apt/lists/*`,
      ];

const npmStep = (specs: string[]) =>
  specs.length === 0 ? [] : [`RUN npm install --global ${specs.join(" ")} \\\n && npm cache clean --force`];

const renderLayerDockerfile = async (
  baseImageId: string,
  config: SandboxConfig,
  home: string | undefined,
) => {
  const custom = await userDockerfile(config.image.dockerfile, home);
  const steps = [
    `FROM ${baseImageId}`,
    "USER root",
    `COPY ${TRUST_FILE} /build/${TRUST_FILE}`,
    `RUN if [ -s /build/${TRUST_FILE} ]; then cp /build/${TRUST_FILE} ${BUILD_CRT} && update-ca-certificates; fi`,
    "ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
    ...aptStep(sortedUnique(config.image.packages)),
    ...npmStep(sortedUnique(config.image.npmGlobal)),
    ...(custom === undefined ? [] : [custom]),
    "USER root",
    `RUN if [ -f ${BUILD_CRT} ]; then rm ${BUILD_CRT} && update-ca-certificates --fresh; fi \\\n && rm -rf /build`,
    "USER pi",
    "WORKDIR /home/pi",
    `ENTRYPOINT ["${ENTRYPOINT}"]`,
    "CMD []",
  ];

  return `${steps.join("\n\n")}\n`;
};

const hasLayer = (config: SandboxConfig) =>
  (config.image.packages ?? []).length > 0 ||
  (config.image.npmGlobal ?? []).length > 0 ||
  config.image.dockerfile !== undefined;

const buildLayer = async (input: EnsureLayerInput, dockerfile: string, tag: string): Promise<LayerImage> => {
  const { id, digest } = await buildInContext(input, {
    prefix: "layer",
    tag,
    fill: async (dir) => {
      await writeFile(join(dir, "Dockerfile"), dockerfile);

      await placeBuildTrust(dir, input.trustPem);
    },
  });

  return { id, digest, tag, built: true };
};

export const ensureLayerImage = async (input: EnsureLayerInput): Promise<LayerImage> => {
  if (!hasLayer(input.config)) {
    await writeWantedLayer(input.stateDir, input.repoHash, undefined);

    return { id: input.baseImageId, built: false };
  }

  const dockerfile = await renderLayerDockerfile(
    input.baseImageId,
    input.config,
    input.env?.HOME || undefined,
  );
  const tag = `${LAYER_TAG_PREFIX}${shortHash(sha256Hex(dockerfile))}`;

  await writeWantedLayer(input.stateDir, input.repoHash, tag);
  const reused = await input.backend.resolveImage(tag).catch(() => undefined);

  return reused === undefined
    ? buildLayer(input, dockerfile, tag)
    : { id: reused.id, digest: reused.digest, tag, built: false };
};
