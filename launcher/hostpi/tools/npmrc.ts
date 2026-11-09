import { join } from "node:path";
import type { SecretRef } from "../../config/index.ts";
import { isSecretName, type NpmrcEntry, parseNpmrc } from "../../shared/index.ts";
import { type Endpoint, hasUrlUserinfo } from "../endpoints.ts";
import { mergeSections, type Section } from "../rules.ts";
import type { ToolsInput } from "../types.ts";
import {
  emptySection,
  placeholderRules,
  readOptional,
  toolPlaceholder,
  urlCredentialSection,
} from "./files.ts";

const REGISTRY_CREDENTIAL = /^\/\/([^/]+)(\/.*)?:(_authToken|_auth|_password)$/;

const WHOLE_VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const UNSCOPED_CREDENTIALS = new Set(["_auth", "_authtoken", "_password"]);

const HOST_TLS_FILES = new Set(["ca", "cafile", "cert", "certfile"]);

const PROXY_KEYS = new Set(["proxy", "https-proxy", "http-proxy"]);

const REGISTRY_KEY = "registry";

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

const nameOf = (key: string) => key.slice(key.lastIndexOf(":") + 1).toLowerCase();

const endpointOf = (authority: string): Endpoint => {
  const [host = "", port] = authority.toLowerCase().split(":");

  return port === undefined ? { host } : { host, port: Number(port) };
};

const pathPrefixOf = (path: string | undefined) => {
  const trimmed = (path ?? "/").replace(/\/+$/, "");

  return trimmed === "" ? undefined : trimmed;
};

const dropped = (key: string, reason: string): Section<NpmrcEntry[]> => ({
  value: [],
  rules: [],
  notices: [`npmrc: ${key} ${reason}`],
});

const renderedValue = (field: string, value: string, placeholder: string) => {
  if (field === "_authToken") {
    return placeholder;
  }

  if (field === "_password") {
    return encode(placeholder);
  }

  const decoded = Buffer.from(value, "base64").toString("utf8");
  const colon = decoded.indexOf(":");

  return colon < 0 ? undefined : encode(`${decoded.slice(0, colon)}:${placeholder}`);
};

const credentialSection = (
  input: ToolsInput,
  entry: NpmrcEntry,
  match: RegExpExecArray,
): Section<NpmrcEntry[]> => {
  const [, authority = "", path, field = ""] = match;
  const variable = WHOLE_VARIABLE.exec(entry.value)?.[1];

  if (variable !== undefined && field !== "_authToken") {
    return dropped(
      entry.key,
      "reads an environment variable; only _authToken may, the key stays on the host",
    );
  }

  const identity = `npmrc:${authority}${path ?? "/"}:${field}`;
  const placeholder = toolPlaceholder(input, identity);
  const value = renderedValue(field, entry.value, placeholder);

  if (value === undefined) {
    return dropped(entry.key, "is not base64 of user:password; the key stays on the host");
  }

  const secret: SecretRef =
    variable === undefined
      ? { file: join(input.home, ".npmrc"), format: "npmrc", key: entry.key }
      : { env: variable };
  const pathPrefix = pathPrefixOf(path);

  return {
    value: [{ key: entry.key, value }],
    rules: placeholderRules(identity, [endpointOf(authority)], placeholder, secret).map((rule) =>
      pathPrefix === undefined ? rule : { ...rule, pathPrefix },
    ),
    notices: [],
  };
};

const expanded = (input: ToolsInput, entry: NpmrcEntry) => {
  const names = [...entry.value.matchAll(VARIABLE)].map((reference) => reference[1] ?? "");

  if (names.some((name) => isSecretName(name) || input.env[name] === undefined)) {
    return undefined;
  }

  return entry.value.replace(VARIABLE, (_, name: string) => input.env[name] ?? "");
};

const plainSection = (input: ToolsInput, entry: NpmrcEntry): Section<NpmrcEntry[]> => {
  const name = nameOf(entry.key);

  if (UNSCOPED_CREDENTIALS.has(name)) {
    return dropped(
      entry.key,
      `has no registry; scope it as //<registry host>/:${name} to use it in the sandbox`,
    );
  }

  if (isSecretName(name) || HOST_TLS_FILES.has(name)) {
    return dropped(entry.key, "stays on the host");
  }

  if (PROXY_KEYS.has(name)) {
    return dropped(
      entry.key,
      "stays on the host; the sandbox reaches the network through the launcher proxy",
    );
  }

  const value = expanded(input, entry);

  if (value === undefined) {
    return dropped(
      entry.key,
      "reads an environment variable that is unset or secret; the key stays on the host",
    );
  }

  if (!hasUrlUserinfo(value)) {
    return { value: [{ key: entry.key, value }], rules: [], notices: [] };
  }

  if (name !== REGISTRY_KEY || value !== entry.value) {
    return dropped(entry.key, "carries credentials in a URL and stays on the host");
  }

  const section = urlCredentialSection(input, {
    label: "npmrc",
    key: entry.key,
    identity: `npmrc:${entry.key}:url`,
    url: value,
    secret: { file: join(input.home, ".npmrc"), format: "npmrc", key: entry.key },
    pathPrefix: pathPrefixOf,
  });

  return { ...section, value: [{ key: entry.key, value: section.value }] };
};

export const deriveNpmrc = async (input: ToolsInput): Promise<Section<NpmrcEntry[] | undefined>> => {
  const text = await readOptional(join(input.home, ".npmrc"));

  if (text === undefined) {
    return emptySection(undefined);
  }

  const merged = mergeSections(
    parseNpmrc(text).map((entry) => {
      const match = REGISTRY_CREDENTIAL.exec(entry.key);

      return match === null ? plainSection(input, entry) : credentialSection(input, entry, match);
    }),
  );

  return { value: merged.values.flat(), rules: merged.rules, notices: merged.notices };
};
