import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { errorMessage, LauncherError, sha256Hex } from "../shared/index.ts";
import { buildProxyArgs } from "./build-proxy.ts";
import { placeBuildTrust, TRUST_FILE } from "./build-trust.ts";
import { isImageRecord, type LayerRecord, readImageRecord, writeImageRecord } from "./record.ts";

interface EnsureLayerInput {
  backend: Backend;
  baseImageId: string;
  config: SandboxConfig;
  stateDir: string;
  trustPem?: string;
  env?: Record<string, string | undefined>;
}

interface LayerImage {
  id: string;
  digest?: string;
  tag?: string;
  built: boolean;
}

const TAG_PREFIX = "pi-sandbox-layer";

const SHORT_HASH = 12;

const BUILD_CRT = "/usr/local/share/ca-certificates/pi-sandbox-build.crt";

const FROM_LINE = /^\s*FROM\s/im;

const userDockerfile = async (path: string | undefined) => {
  if (path === undefined) {
    return undefined;
  }

  const text = await readFile(path, "utf8").catch((error: unknown) => {
    throw new LauncherError(`image.dockerfile: cannot read ${path}: ${errorMessage(error)}`);
  });

  if (FROM_LINE.test(text)) {
    throw new LauncherError(
      `image.dockerfile: ${path} has a FROM line`,
      "drop the FROM line, the launcher builds the layer on top of the sandbox image",
    );
  }

  return text.trimEnd();
};

const aptStep = (packages: string[]) =>
  packages.length === 0
    ? []
    : [
        `RUN apt-get update \\\n && apt-get install -y --no-install-recommends ${packages.join(" ")} \\\n && rm -rf /var/lib/apt/lists/*`,
      ];

const npmStep = (specs: string[]) =>
  specs.length === 0 ? [] : [`RUN npm install --global ${specs.join(" ")} \\\n && npm cache clean --force`];

const renderLayerDockerfile = async (baseImageId: string, config: SandboxConfig) => {
  const custom = await userDockerfile(config.image.dockerfile);
  const steps = [
    `FROM ${baseImageId}`,
    "USER root",
    `COPY ${TRUST_FILE} /build/${TRUST_FILE}`,
    `RUN if [ -s /build/${TRUST_FILE} ]; then cp /build/${TRUST_FILE} ${BUILD_CRT} && update-ca-certificates; fi`,
    "ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt",
    ...aptStep(config.image.packages ?? []),
    ...npmStep(config.image.npmGlobal ?? []),
    ...(custom === undefined ? [] : [custom]),
    "USER root",
    `RUN if [ -f ${BUILD_CRT} ]; then rm ${BUILD_CRT} && update-ca-certificates --fresh; fi \\\n && rm -rf /build`,
    "USER pi",
  ];

  return `${steps.join("\n\n")}\n`;
};

const hasLayer = (config: SandboxConfig) =>
  (config.image.packages ?? []).length > 0 ||
  (config.image.npmGlobal ?? []).length > 0 ||
  config.image.dockerfile !== undefined;

const reusableLayer = async (input: EnsureLayerInput, inputsHash: string) => {
  const record = await readImageRecord(input.stateDir);
  const layer = record?.layer;

  if (layer === undefined || layer.inputsHash !== inputsHash) {
    return undefined;
  }

  const local = await input.backend.resolveImage(layer.tag).catch(() => undefined);

  return local?.digest === layer.digest ? layer : undefined;
};

const recordLayer = async (stateDir: string, layer: LayerRecord) => {
  const record = await readImageRecord(stateDir);

  if (!isImageRecord(record)) {
    return;
  }

  await writeImageRecord(stateDir, { ...record, layer });
};

const buildLayer = async (
  input: EnsureLayerInput,
  dockerfile: string,
  inputsHash: string,
): Promise<LayerImage> => {
  const tag = `${TAG_PREFIX}:${inputsHash.slice(0, SHORT_HASH)}`;
  const contextDir = join(input.stateDir, `layer-${randomBytes(4).toString("hex")}`);

  try {
    await mkdir(contextDir, { recursive: true });

    await writeFile(join(contextDir, "Dockerfile"), dockerfile);

    await placeBuildTrust(contextDir, input.trustPem);

    const buildArgs = buildProxyArgs(input.config.egress.parentProxy, input.env ?? {});
    const { id, digest } = await input.backend.buildImage(contextDir, tag, buildArgs);

    await recordLayer(input.stateDir, { tag, id, digest, inputsHash });

    return { id, digest, tag, built: true };
  } finally {
    await rm(contextDir, { recursive: true, force: true });
  }
};

export const ensureLayerImage = async (input: EnsureLayerInput): Promise<LayerImage> => {
  if (!hasLayer(input.config)) {
    return { id: input.baseImageId, built: false };
  }

  const dockerfile = await renderLayerDockerfile(input.baseImageId, input.config);
  const inputsHash = sha256Hex(dockerfile);
  const reused = await reusableLayer(input, inputsHash);

  return reused === undefined
    ? buildLayer(input, dockerfile, inputsHash)
    : { id: reused.id, digest: reused.digest, tag: reused.tag, built: false };
};
