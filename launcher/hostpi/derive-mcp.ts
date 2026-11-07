import { join } from "node:path";
import { isSecretName, type VaultDiscovered, type VaultServer, vaultPlaceholders } from "../shared/index.ts";
import { type Endpoint, endpointOf } from "./endpoints.ts";
import { deriveHeaders } from "./headers.ts";
import { isJsonObject, objectOr } from "./json.ts";
import { type DeriveContext, mergeSections, placeholderOf, rulesFor, type Section } from "./rules.ts";
import type { DeriveVault, JsonObject } from "./types.ts";
import { hasQueryCredential, hasUrlPassword, stripUserinfo } from "./userinfo.ts";
import { vaultCandidate } from "./vault.ts";

type ServerSection = Section<[string, unknown]> & { vault?: VaultServer; dropped?: boolean };

export interface McpDeriveOptions {
  signedIn: string[];
  vault?: DeriveVault;
}

export type McpSection = Section<JsonObject> & { vault: VaultServer[] };

const AUTHORIZATION = "authorization";

const isHttpServer = (server: JsonObject) => typeof server.url === "string";

const isStdioServer = (server: JsonObject) => typeof server.command === "string";

const hasAuthorization = (headers: JsonObject | undefined) =>
  Object.keys(headers ?? {}).some((name) => name.toLowerCase() === AUTHORIZATION);

const oauthSection = (
  context: DeriveContext,
  name: string,
  url: string,
  endpoints: Endpoint[],
  signedIn: string[],
): Section<JsonObject> => {
  const identity = `mcp:${name}:oauth`;
  const placeholder = placeholderOf(context, identity);
  const loginNotice = signedIn.includes(name) ? [] : [`mcp ${name}: sign in with pi mcp login ${name}`];

  return {
    value: { Authorization: `Bearer ${placeholder}` },
    rules: rulesFor(identity, endpoints, { placeholder, secret: { mcpOAuth: { server: name, url } } }),
    notices: loginNotice,
  };
};

const vaultDiscoveryOf = (name: string, server: JsonObject, options: McpDeriveOptions) => {
  const candidate = options.vault?.enabled === true ? vaultCandidate(name, server) : undefined;
  const discovery = candidate === undefined ? undefined : options.vault?.discovery[name];

  return discovery?.ok === true && discovery.url === candidate?.url ? { candidate, discovery } : undefined;
};

const vaultServerOf = (
  context: DeriveContext,
  name: string,
  url: string,
  oauth: VaultServer["oauth"],
  discovery: VaultDiscovered,
): VaultServer => ({
  server: name,
  url,
  ruleId: `derived:mcp:${name}:oauth`,
  ...vaultPlaceholders(context.salt, name),
  ...(oauth === undefined ? {} : { oauth }),
  discovery,
});

const vaultNotice = (name: string, signedIn: string[]) =>
  signedIn.includes(name)
    ? []
    : [`mcp ${name}: sign in from /mcp in pi, or with pi mcp login ${name} in the shell`];

const httpServer = (
  context: DeriveContext,
  name: string,
  server: JsonObject,
  options: McpDeriveOptions,
): ServerSection => {
  const stripped = stripUserinfo(
    {
      label: `mcp ${name}`,
      key: `mcpServers.${name}.url`,
      identity: `mcp:${name}:url:userinfo`,
      file: join(context.agentDir, "mcp.json"),
      pointer: ["mcpServers", name, "url"],
    },
    server.url,
  );
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

  const vault = vaultDiscoveryOf(name, server, options);

  if (vault !== undefined) {
    const identity = `mcp:${name}:oauth`;
    const vaultServer = vaultServerOf(
      context,
      name,
      vault.candidate.url,
      vault.candidate.oauth,
      vault.discovery,
    );
    const body = { placeholder: vaultServer.access, secret: { mcpOAuth: { server: name, url } } };
    const definition = {
      ...rest,
      ...(headers.value === undefined ? {} : { headers: headers.value }),
      ...(vaultServer.oauth === undefined ? {} : { oauth: vaultServer.oauth }),
    };

    return {
      value: [name, definition],
      rules: [...stripped.rules, ...headers.rules, ...rulesFor(identity, endpoints, body)],
      notices: [...stripped.notices, ...headers.notices, ...vaultNotice(name, options.signedIn)],
      vault: vaultServer,
    };
  }

  const bearer =
    hasAuthorization(headers.value) || hasUrlPassword(server.url)
      ? undefined
      : oauthSection(context, name, url, endpoints, options.signedIn);

  return {
    value: [
      name,
      headers.value === undefined && bearer === undefined
        ? rest
        : { ...rest, headers: { ...headers.value, ...bearer?.value } },
    ],
    rules: [...stripped.rules, ...headers.rules, ...(bearer?.rules ?? [])],
    notices: [...stripped.notices, ...headers.notices, ...(bearer?.notices ?? [])],
  };
};

const hasUrlUserinfo = (value: string) => {
  try {
    const url = new URL(value);

    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
};

const isSecretEnvValue = (variable: string, value: unknown) =>
  typeof value === "string" &&
  (value.includes("${") || value.startsWith("!") || isSecretName(variable) || hasUrlUserinfo(value));

const FLAG_WITH_VALUE = /^(--?[A-Za-z0-9][A-Za-z0-9_.-]*)=(.*)$/s;

const placeholderNotice = (name: string, label: string) =>
  `mcp ${name}: ${label} is a placeholder in the sandbox; add credentials.rules for the host it calls`;

const stdioArg = (context: DeriveContext, name: string, arg: unknown, index: number) => {
  if (typeof arg !== "string") {
    return { value: arg, notices: [] };
  }

  const placeholder = placeholderOf(context, `mcp:${name}:arg:${index}`);
  const flag = FLAG_WITH_VALUE.exec(arg);
  const flagName = flag?.[1] ?? "";

  if (flag !== null && isSecretName(flagName.replace(/^-+/, ""))) {
    return { value: `${flagName}=${placeholder}`, notices: [placeholderNotice(name, flagName)] };
  }

  return hasUrlUserinfo(flag?.[2] ?? arg)
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

  const args = server.args.map((arg, index) => stdioArg(context, name, arg, index));

  return {
    server: { ...server, args: args.map((arg) => arg.value) },
    notices: args.flatMap((arg) => arg.notices),
  };
};

const stdioServer = (context: DeriveContext, name: string, original: JsonObject): ServerSection => {
  const { server, notices: argNotices } = stdioArgs(context, name, original);

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
  options: McpDeriveOptions,
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
    return httpServer(context, name, server, options);
  }

  return isStdioServer(server)
    ? stdioServer(context, name, server)
    : { value: [name, server], rules: [], notices: [] };
};

export const deriveMcp = (context: DeriveContext, mcp: JsonObject, options: McpDeriveOptions): McpSection => {
  const sections = Object.entries(objectOr(mcp.mcpServers)).map(([name, server]) =>
    serverSection(context, name, server, options),
  );
  const merged = mergeSections(sections.filter((section) => section.dropped !== true));

  return {
    value: { ...mcp, mcpServers: Object.fromEntries(merged.values) },
    notices: sections.flatMap((section) => section.notices),
    rules: merged.rules,
    vault: sections.flatMap((section) => (section.vault === undefined ? [] : [section.vault])),
  };
};
