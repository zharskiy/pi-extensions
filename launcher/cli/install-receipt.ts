import { readFile } from "node:fs/promises";
import {
  isJsonObject,
  type JsonObject,
  parseJsonObject,
  stateLayout,
  writeFileAtomic,
} from "../shared/index.ts";

export const PACKAGE_NAME = "@zharskiy/pinata";

const INSTALLER_API = 1;

const RECEIPT_SCHEMA = 1;

const RECEIPT_MODE = 0o600;

export const CONFIG_OUTCOMES = ["created", "unchanged", "updated", "kept", "replaced"] as const;

export type ConfigOutcome = (typeof CONFIG_OUTCOMES)[number];

export const SMOKE_RESULTS = ["passed", "failed", "skipped", "pending"] as const;

export const ROOTS_CONFIG_SOURCE = "--root";

type SmokeResult = (typeof SMOKE_RESULTS)[number];

export const INSTALL_MODES = ["global", "checkout"] as const;

type InstallMode = (typeof INSTALL_MODES)[number];

interface ConfigRecord {
  from: string;
  sha256: string | null;
  outcome: ConfigOutcome;
}

export interface InstallReceipt {
  schemaVersion: number;
  installerApi: number;
  installedAt: string;
  package: { name: string; version: string; spec: string | null; mode: InstallMode };
  bootstrap: { api: number; version: string | null } | null;
  pi: { version: string | null };
  extensions: { source: string } | null;
  config: ConfigRecord | null;
  smoke: SmokeResult;
}

export interface StoredReceipt {
  version?: string;
  mode?: string;
  installedAt?: string;
  smoke?: string;
  extensions: { source: string } | null;
  config: ConfigRecord | null;
}

const SHA256 = /^[0-9a-f]{64}$/;

const textOf = (value: unknown) => (typeof value === "string" ? value : undefined);

const objectAt = (value: JsonObject, key: string) => {
  const found = value[key];

  return isJsonObject(found) ? found : undefined;
};

const isOutcome = (value: unknown): value is ConfigOutcome =>
  typeof value === "string" && (CONFIG_OUTCOMES as readonly string[]).includes(value);

const configOf = (value: JsonObject | undefined): ConfigRecord | null => {
  const from = textOf(value?.from);
  const sha256 = textOf(value?.sha256);
  const outcome = value?.outcome;

  if (from === undefined || !isOutcome(outcome)) {
    return null;
  }

  return { from, sha256: sha256 !== undefined && SHA256.test(sha256) ? sha256 : null, outcome };
};

const extensionsOf = (value: JsonObject | undefined) => {
  const source = textOf(value?.source);

  return source === undefined || source === "" ? null : { source };
};

const isKnownSchema = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= RECEIPT_SCHEMA;

const storedOf = (value: JsonObject): StoredReceipt => {
  const recorded = objectAt(value, "package");

  return {
    version: textOf(recorded?.version),
    mode: textOf(recorded?.mode),
    installedAt: textOf(value.installedAt),
    smoke: textOf(value.smoke),
    extensions: extensionsOf(objectAt(value, "extensions")),
    config: configOf(objectAt(value, "config")),
  };
};

export const readReceipt = async (stateDir: string): Promise<StoredReceipt | undefined> => {
  const text = await readFile(stateLayout(stateDir).installReceipt, "utf8").catch(() => undefined);
  const value = text === undefined ? undefined : parseJsonObject(text);

  return value === undefined || !isKnownSchema(value.schemaVersion) ? undefined : storedOf(value);
};

export const writeReceipt = (
  stateDir: string,
  receipt: Omit<InstallReceipt, "schemaVersion" | "installerApi">,
) =>
  writeFileAtomic(
    stateLayout(stateDir).installReceipt,
    `${JSON.stringify({ schemaVersion: RECEIPT_SCHEMA, installerApi: INSTALLER_API, ...receipt }, null, 2)}\n`,
    { mode: RECEIPT_MODE },
  );

const JSON_SUFFIX = /\.json$/;

export const proposedConfigFile = (userConfigFile: string) =>
  JSON_SUFFIX.test(userConfigFile)
    ? userConfigFile.replace(JSON_SUFFIX, ".proposed.json")
    : `${userConfigFile}.proposed`;

export const backupConfigFile = (userConfigFile: string) => `${userConfigFile}.bak`;
