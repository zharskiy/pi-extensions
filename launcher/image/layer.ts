import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import {
  errorMessage,
  expandHome,
  GUEST_PATHS,
  LauncherError,
  shortHash,
  stableHash,
} from "../shared/index.ts";
import { buildInContext, imageAsset } from "./context.ts";
import { writeCurrentLayer } from "./record.ts";
import { caFiles, JDK_NET_PROPERTIES, jdkNetProperties, TRUST_IMAGE_PATHS, TRUST_SCRIPT } from "./trust.ts";

interface EnsureLayerInput {
  backend: Backend;
  baseImageId: string;
  config: SandboxConfig;
  stateDir: string;
  trustPem?: string;
  proxyCaPem?: string;
  env?: Record<string, string | undefined>;
  preparing?: () => void;
  progress?: (step: string) => void;
}

interface LayerImage {
  id: string;
  digest?: string;
  tag: string;
  built: boolean;
}

export const LAYER_TAG_PREFIX = "pinata-layer:";

const CA_CONTEXT_DIR = "ca";

const ENTRYPOINT_SCRIPT = "entrypoint.sh";

const BASH_ENV_SCRIPT = "bash-env.sh";

const FORWARDER_SCRIPT = "forwarder.mjs";

const BASH_ENV_PATH = `${TRUST_IMAGE_PATHS.libDir}/${BASH_ENV_SCRIPT}`;

const BASHRC = "/etc/bash.bashrc";

const NO_CA_STORE =
  "the sandbox layer needs update-ca-certificates (Debian's ca-certificates package) in the base image to trust the sandbox CAs";

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

const systemTrustStep = () => {
  const { caDir, libDir, script } = TRUST_IMAGE_PATHS;

  return [
    `COPY ${CA_CONTEXT_DIR}/ ${caDir}/`,
    `COPY ${TRUST_SCRIPT} ${JDK_NET_PROPERTIES} ${libDir}/`,
    `RUN command -v update-ca-certificates >/dev/null || { echo "${NO_CA_STORE}" >&2; exit 1; } \\\n && mkdir -p ${caDir} \\\n && chmod 0755 ${caDir} ${script} \\\n && chmod 0644 ${libDir}/${JDK_NET_PROPERTIES} \\\n && find ${caDir} -type f -exec chmod 0644 {} + \\\n && update-ca-certificates`,
  ];
};

const sandboxScriptsStep = () => {
  const source = `. ${BASH_ENV_PATH}`;

  return [
    `COPY ${BASH_ENV_SCRIPT} ${FORWARDER_SCRIPT} ${TRUST_IMAGE_PATHS.libDir}/`,
    `COPY ${ENTRYPOINT_SCRIPT} ${GUEST_PATHS.entrypoint}`,
    `RUN chmod 0644 ${BASH_ENV_PATH} ${TRUST_IMAGE_PATHS.libDir}/${FORWARDER_SCRIPT} \\\n && chmod 0755 ${GUEST_PATHS.entrypoint} \\\n && touch ${BASHRC} \\\n && { grep -qxF '${source}' ${BASHRC} || { printf '%s\\n' '${source}' | cat - ${BASHRC} > ${BASHRC}.new && mv ${BASHRC}.new ${BASHRC}; }; }`,
    `ENV BASH_ENV=${BASH_ENV_PATH}`,
  ];
};

const renderLayerDockerfile = async (
  baseImageId: string,
  config: SandboxConfig,
  home: string | undefined,
) => {
  const custom = await userDockerfile(config.image.dockerfile, home);
  const steps = [
    `FROM ${baseImageId}`,
    "USER root",
    ...systemTrustStep(),
    ...sandboxScriptsStep(),
    `ARG NODE_EXTRA_CA_CERTS=${GUEST_PATHS.caBundle}`,
    ...aptStep(sortedUnique(config.image.packages)),
    ...npmStep(sortedUnique(config.image.npmGlobal)),
    ...(custom === undefined ? [] : [custom]),
    "USER root",
    `RUN ${TRUST_IMAGE_PATHS.script}`,
    "USER pi",
    "WORKDIR /home/pi",
    `ENTRYPOINT ["${GUEST_PATHS.entrypoint}"]`,
    "CMD []",
  ];

  return `${steps.join("\n\n")}\n`;
};

const layerContext = async (input: EnsureLayerInput): Promise<Record<string, string>> => {
  const dockerfile = await renderLayerDockerfile(
    input.baseImageId,
    input.config,
    input.env?.HOME || undefined,
  );
  const certificates = await caFiles({ proxyCaPem: input.proxyCaPem, extraPem: input.trustPem });
  const caEntries = Object.entries(certificates).map(([name, pem]) => [join(CA_CONTEXT_DIR, name), pem]);

  return {
    Dockerfile: dockerfile,
    [TRUST_SCRIPT]: await readFile(imageAsset(TRUST_SCRIPT), "utf8"),
    [JDK_NET_PROPERTIES]: jdkNetProperties(),
    [ENTRYPOINT_SCRIPT]: await readFile(imageAsset(ENTRYPOINT_SCRIPT), "utf8"),
    [BASH_ENV_SCRIPT]: await readFile(imageAsset(BASH_ENV_SCRIPT), "utf8"),
    [FORWARDER_SCRIPT]: await readFile(imageAsset(FORWARDER_SCRIPT), "utf8"),
    ...Object.fromEntries(caEntries),
  };
};

const writeContext = async (dir: string, files: Record<string, string>) => {
  await mkdir(join(dir, CA_CONTEXT_DIR), { recursive: true });

  await Promise.all(
    Object.entries(files).map(async ([name, text]) => {
      await mkdir(dirname(join(dir, name)), { recursive: true });

      await writeFile(join(dir, name), text);
    }),
  );
};

const fetchesPackages = (config: SandboxConfig) =>
  (config.image.packages ?? []).length > 0 ||
  (config.image.npmGlobal ?? []).length > 0 ||
  config.image.dockerfile !== undefined;

const buildLayer = async (input: EnsureLayerInput, files: Record<string, string>, tag: string) => {
  const fetches = fetchesPackages(input.config);

  input.preparing?.();

  const { id, digest } = await buildInContext(
    { ...input, env: fetches ? input.env : {} },
    {
      prefix: "layer",
      tag,
      offline: !fetches,
      fill: (dir) => writeContext(dir, files),
    },
  );

  return { id, digest, tag, built: true };
};

export const ensureLayerImage = async (input: EnsureLayerInput): Promise<LayerImage> => {
  const files = await layerContext(input);
  const tag = `${LAYER_TAG_PREFIX}${shortHash(stableHash(files))}`;

  await writeCurrentLayer(input.stateDir, tag);

  const reused = await input.backend.resolveImage(tag).catch(() => undefined);

  return reused === undefined
    ? buildLayer(input, files, tag)
    : { id: reused.id, digest: reused.digest, tag, built: false };
};
