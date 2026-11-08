import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { errorMessage, LauncherError, sha256Hex } from "../shared/index.ts";
import { placeBuildTrust, TRUST_FILE } from "./build-trust.ts";
import { buildInContext, reusableImage } from "./context.ts";
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

const FORBIDDEN_DIRECTIVES = new Set([
  "ENTRYPOINT",
  "CMD",
  "USER",
  "HEALTHCHECK",
  "ONBUILD",
  "SHELL",
  "STOPSIGNAL",
  "VOLUME",
]);

const FORBIDDEN_VARIABLES = new Set([
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "PATH",
  "HOME",
  "BASH_ENV",
]);

const FIRST_NAME = /^([A-Za-z_][A-Za-z0-9_]*)/;

const ASSIGNED_NAME = /\s([A-Za-z_][A-Za-z0-9_]*)=/g;

const FROM_FLAG = /(^|\s)--from[=\s]/i;

const HEREDOC_DIRECTIVES = new Set(["RUN", "COPY", "ADD"]);

const HEREDOC = /(?<!<)<<(?!<)(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

const CONTINUED = /\\\s*$/;

interface Instruction {
  directive: string;
  args: string;
}

interface Terminator {
  word: string;
  tabs: boolean;
}

interface ParseState {
  instructions: Instruction[];
  pending?: string;
  bodies: Terminator[];
}

const instructionOf = (text: string): Instruction => {
  const [word = "", ...rest] = text.trim().split(/\s+/);

  return { directive: word.toUpperCase(), args: rest.join(" ") };
};

const heredocsOf = (instruction: Instruction): Terminator[] =>
  HEREDOC_DIRECTIVES.has(instruction.directive)
    ? [...instruction.args.matchAll(HEREDOC)].map((match) => ({
        word: match[3] ?? "",
        tabs: match[1] === "-",
      }))
    : [];

const inBody = (state: ParseState, line: string): ParseState => {
  const [terminator, ...rest] = state.bodies;
  const candidate = terminator?.tabs === true ? line.replace(/^\t+/, "") : line;

  return candidate === terminator?.word ? { ...state, bodies: rest } : state;
};

const atInstruction = (state: ParseState, line: string): ParseState => {
  const trimmed = line.trim();

  if (trimmed === "" || trimmed.startsWith("#")) {
    return state;
  }

  const text = state.pending === undefined ? line : `${state.pending} ${line}`;

  if (CONTINUED.test(text)) {
    return { ...state, pending: text.replace(CONTINUED, "") };
  }

  const instruction = instructionOf(text);

  return {
    instructions: [...state.instructions, instruction],
    bodies: heredocsOf(instruction),
  };
};

const instructionsOf = (text: string): Instruction[] =>
  text
    .split(/\r?\n/)
    .reduce<ParseState>(
      (state, line) => (state.bodies.length > 0 ? inBody(state, line) : atInstruction(state, line)),
      { instructions: [], bodies: [] },
    ).instructions;

const variableNames = (args: string) => [
  ...(FIRST_NAME.exec(args)?.slice(1, 2) ?? []),
  ...[...` ${args}`.matchAll(ASSIGNED_NAME)].map((match) => match[1] ?? ""),
];

const isForbiddenVariable = (name: string) => {
  const upper = name.toUpperCase();

  return FORBIDDEN_VARIABLES.has(upper) || upper.startsWith("PI_");
};

const problemOf = (instruction: Instruction) => {
  const { directive, args } = instruction;

  if (directive === "FROM") {
    return "has a FROM line";
  }

  if (FORBIDDEN_DIRECTIVES.has(directive)) {
    return `has a ${directive} instruction`;
  }

  if ((directive === "COPY" || directive === "ADD") && FROM_FLAG.test(args)) {
    return `has a ${directive} --from instruction`;
  }

  const variable =
    directive === "ENV" || directive === "ARG" ? variableNames(args).find(isForbiddenVariable) : undefined;

  return variable === undefined ? undefined : `sets ${variable} with ${directive}`;
};

const assertAllowedLayer = (path: string, text: string) => {
  const problem = instructionsOf(text)
    .map(problemOf)
    .find((found) => found !== undefined);

  if (problem !== undefined) {
    throw new LauncherError(
      `image.dockerfile: ${path} ${problem}`,
      "image.dockerfile may only add RUN, COPY, ADD, ENV, ARG, WORKDIR, LABEL and EXPOSE steps on top of the sandbox image",
    );
  }
};

const userDockerfile = async (path: string | undefined) => {
  if (path === undefined) {
    return undefined;
  }

  const text = await readFile(path, "utf8").catch((error: unknown) => {
    throw new LauncherError(`image.dockerfile: cannot read ${path}: ${errorMessage(error)}`);
  });

  assertAllowedLayer(path, text);

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

  return (await reusableImage(input.backend, layer.tag, layer.digest)) === undefined ? undefined : layer;
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
  const { id, digest } = await buildInContext(input, {
    prefix: "layer",
    tag,
    fill: async (dir) => {
      await writeFile(join(dir, "Dockerfile"), dockerfile);

      await placeBuildTrust(dir, input.trustPem);
    },
  });

  await recordLayer(input.stateDir, { tag, id, digest, inputsHash });

  return { id, digest, tag, built: true };
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
