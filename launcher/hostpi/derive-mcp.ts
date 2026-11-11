import { isAbsolute, join } from "node:path";
import { isJsonObject, isSecretShapedValue } from "../shared/index.ts";
import type { ProviderCredentials } from "./derive-auth.ts";
import { type Endpoint, endpointOf, hasQueryCredential, strippedUrl } from "./endpoints.ts";
import { deriveHeaders } from "./headers.ts";
import { objectOr } from "./json.ts";
import { isDisabledServer, oauthTarget, providerAuthOf } from "./mcp-auth.ts";
import { type DeriveContext, mergeSections, placeholderOf, rulesFor, type Section } from "./rules.ts";
import type { JsonObject } from "./types.ts";

type ServerSection = Section<[string, unknown]> & { dropped?: boolean };

export type McpSection = Section<JsonObject>;

const isHttpServer = (server: JsonObject) => typeof server.url === "string";

const isStdioServer = (server: JsonObject) => typeof server.command === "string";

const oauthSection = (
  context: DeriveContext,
  name: string,
  url: string,
  endpoints: Endpoint[],
): Section<JsonObject> => {
  const identity = `mcp:${name}:oauth`;
  const placeholder = placeholderOf(context, identity);

  return {
    value: { Authorization: `Bearer ${placeholder}` },
    rules: rulesFor(identity, endpoints, { placeholder, secret: { mcpOAuth: { server: name, url } } }),
    notices: [],
  };
};

const providerSection = (
  name: string,
  provider: string,
  endpoints: Endpoint[],
  credentials: ProviderCredentials,
): Section<JsonObject> => {
  const body = Object.hasOwn(credentials, provider) ? credentials[provider] : undefined;

  return body === undefined
    ? {
        value: {},
        rules: [],
        notices: [`mcp ${name}: auth.provider ${provider} has no host credential, so no rule`],
      }
    : { value: {}, rules: rulesFor(`mcp:${name}:auth`, endpoints, body), notices: [] };
};

const authSection = (
  context: DeriveContext,
  name: string,
  server: JsonObject,
  endpoints: Endpoint[],
  credentials: ProviderCredentials,
): Section<JsonObject> | undefined => {
  const provider = providerAuthOf(server);

  if (isDisabledServer(server)) {
    return undefined;
  }

  if (provider !== undefined) {
    return providerSection(name, provider, endpoints, credentials);
  }

  const target = oauthTarget(name, server);

  return target === undefined ? undefined : oauthSection(context, name, target, endpoints);
};

const httpServer = (
  context: DeriveContext,
  name: string,
  server: JsonObject,
  credentials: ProviderCredentials,
): ServerSection => {
  const stripped = strippedUrl(`mcp ${name}`, `mcpServers.${name}.url`, server.url);
  const url = String(stripped.value);
  const result = endpointOf(url);
  const endpoints = "endpoint" in result ? [result.endpoint] : [];
  const { oauth: _oauth, headers: _headers, ...original } = server;
  const rest = { ...original, url };
  const headers = deriveHeaders(
    context,
    {
      label: `mcp ${name}`,
      identity: `mcp:${name}`,
      file: join(context.agentDir, "mcp.json"),
      pointer: ["mcpServers", name, "headers"],
      endpoints,
    },
    server.headers,
  );

  if (!("endpoint" in result)) {
    const reason =
      "local" in result
        ? `${result.local} is a host-local or plain-http endpoint, not reachable from the sandbox`
        : "the url is not valid";

    return {
      value: [name, headers.value === undefined ? rest : { ...rest, headers: headers.value }],
      rules: [],
      notices: [...stripped.notices, `mcp ${name}: ${reason}`, ...headers.notices],
    };
  }

  const bearer = authSection(context, name, server, endpoints, credentials);
  const extra = bearer === undefined || Object.keys(bearer.value).length === 0 ? undefined : bearer.value;
  const rules = isDisabledServer(server) ? [] : [...headers.rules, ...(bearer?.rules ?? [])];

  return {
    value: [
      name,
      headers.value === undefined && extra === undefined
        ? rest
        : { ...rest, headers: { ...headers.value, ...extra } },
    ],
    rules,
    notices: [...stripped.notices, ...headers.notices, ...(bearer?.notices ?? [])],
  };
};

const SECRET_WORDS = [
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "apikey",
  "privatekey",
];

const SHORT_SECRET_SEGMENTS = new Set(["pass", "pat", "jwt", "dsn"]);

const isSecretSegment = (segment: string) =>
  SHORT_SECRET_SEGMENTS.has(segment) || SECRET_WORDS.some((word) => segment.endsWith(word));

const QUALIFIERS = new Set([
  "no",
  "max",
  "min",
  "count",
  "limit",
  "size",
  "length",
  "file",
  "dir",
  "path",
  "mode",
  "url",
  "timeout",
  "ttl",
  "type",
  "name",
  "header",
  "env",
  "var",
]);

const INERT_WORDS = new Set(["", "true", "false", "yes", "no", "on", "off"]);

const segmentsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== "");

const isMcpSecretName = (name: string) => {
  const segments = segmentsOf(name);
  const first = segments[0] ?? "";
  const last = segments.at(-1) ?? "";

  if (segments.length === 0 || QUALIFIERS.has(first) || QUALIFIERS.has(last)) {
    return false;
  }

  return segments.some(isSecretSegment) || last.endsWith("key");
};

const isInertValue = (value: string) =>
  INERT_WORDS.has(value.trim().toLowerCase()) || /^-?\d+(\.\d+)?$/.test(value.trim());

const isSecretEnvValue = (variable: string, value: unknown) =>
  typeof value === "string" &&
  !isInertValue(value) &&
  (value.includes("${") || value.startsWith("!") || isMcpSecretName(variable) || isSecretShapedValue(value));

const FLAG_WITH_VALUE = /^(--?[A-Za-z0-9][A-Za-z0-9_.-]*)=(.*)$/s;

const BARE_FLAG = /^--?([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

const isSecretFlag = (arg: unknown) => {
  const name = typeof arg === "string" ? BARE_FLAG.exec(arg)?.[1] : undefined;

  return name !== undefined && isMcpSecretName(name);
};

const placeholderNotice = (name: string, label: string) =>
  `mcp ${name}: ${label} is a placeholder in the sandbox; add credentials.rules for the host it calls`;

const stdioArg = (context: DeriveContext, name: string, args: unknown[], index: number) => {
  const arg = args[index];

  if (typeof arg !== "string") {
    return { value: arg, notices: [] };
  }

  const placeholder = placeholderOf(context, `mcp:${name}:arg:${index}`);

  if (index > 0 && isSecretFlag(args[index - 1]) && !arg.startsWith("-") && !isInertValue(arg)) {
    return { value: placeholder, notices: [placeholderNotice(name, `args[${index}]`)] };
  }

  const flag = FLAG_WITH_VALUE.exec(arg);
  const flagName = flag?.[1] ?? "";
  const flagValue = flag?.[2] ?? "";

  if (flag !== null && isMcpSecretName(flagName.replace(/^-+/, "")) && !isInertValue(flagValue)) {
    return { value: `${flagName}=${placeholder}`, notices: [placeholderNotice(name, flagName)] };
  }

  return isSecretShapedValue(flag === null ? arg : flagValue)
    ? {
        value: flag === null ? placeholder : `${flagName}=${placeholder}`,
        notices: [placeholderNotice(name, `args[${index}]`)],
      }
    : { value: arg, notices: [] };
};

const stdioArgs = (
  context: DeriveContext,
  name: string,
  server: JsonObject,
): { server: JsonObject; notices: string[] } => {
  if (!Array.isArray(server.args)) {
    return { server, notices: [] };
  }

  const list: unknown[] = server.args;
  const args = list.map((_, index) => stdioArg(context, name, list, index));

  return {
    server: { ...server, args: args.map((arg) => arg.value) },
    notices: args.flatMap((arg) => arg.notices),
  };
};

const hostPathNotices = (name: string, server: JsonObject) =>
  (["command", "cwd"] as const).flatMap((field) => {
    const value = server[field];

    return typeof value === "string" && isAbsolute(value)
      ? [`mcp ${name}: ${field} ${value} is a host path, which the sandbox may not have`]
      : [];
  });

const stdioServer = (context: DeriveContext, name: string, original: JsonObject): ServerSection => {
  const stdio = stdioArgs(context, name, original);
  const { server } = stdio;
  const argNotices = [...hostPathNotices(name, server), ...stdio.notices];

  if (!isJsonObject(server.env)) {
    return { value: [name, server], rules: [], notices: argNotices };
  }

  const entries = Object.entries(server.env);
  const secret = entries
    .filter(([variable, value]) => isSecretEnvValue(variable, value))
    .map(([variable]) => variable);
  const env = Object.fromEntries(
    entries.map(([variable, value]) => [
      variable,
      secret.includes(variable) ? placeholderOf(context, `mcp:${name}:env:${variable}`) : value,
    ]),
  );

  return {
    value: [name, { ...server, env }],
    rules: [],
    notices: [...argNotices, ...secret.map((variable) => placeholderNotice(name, variable))],
  };
};

const serverSection = (
  context: DeriveContext,
  name: string,
  server: unknown,
  credentials: ProviderCredentials,
): ServerSection => {
  if (!isJsonObject(server)) {
    return { value: [name, server], rules: [], notices: [] };
  }

  if (isHttpServer(server) && hasQueryCredential(server.url)) {
    return {
      value: [name, undefined],
      rules: [],
      notices: [`mcp ${name}: the url carries a credential in its query string; add a header rule instead`],
      dropped: true,
    };
  }

  if (isHttpServer(server)) {
    return httpServer(context, name, server, credentials);
  }

  return isStdioServer(server)
    ? stdioServer(context, name, server)
    : { value: [name, server], rules: [], notices: [] };
};

export const deriveMcp = (
  context: DeriveContext,
  mcp: JsonObject,
  credentials: ProviderCredentials,
): McpSection => {
  const sections = Object.entries(objectOr(mcp.mcpServers)).map(([name, server]) =>
    serverSection(context, name, server, credentials),
  );
  const merged = mergeSections(sections.filter((section) => section.dropped !== true));

  return {
    value: { ...mcp, mcpServers: Object.fromEntries(merged.values) },
    notices: sections.flatMap((section) => section.notices),
    rules: merged.rules,
  };
};
