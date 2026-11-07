import { join } from "node:path";
import { isSecretName } from "../shared/index.ts";
import { type Endpoint, endpointOf } from "./endpoints.ts";
import { deriveHeaders } from "./headers.ts";
import { isJsonObject, objectOr } from "./json.ts";
import { type DeriveContext, mergeSections, placeholderOf, rulesFor, type Section } from "./rules.ts";
import type { JsonObject } from "./types.ts";
import { hasUrlPassword, stripUserinfo } from "./userinfo.ts";

type ServerSection = Section<[string, unknown]>;

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

const httpServer = (
  context: DeriveContext,
  name: string,
  server: JsonObject,
  signedIn: string[],
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

  const bearer =
    hasAuthorization(headers.value) || hasUrlPassword(server.url)
      ? undefined
      : oauthSection(context, name, url, endpoints, signedIn);

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

const isSecretEnvValue = (variable: string, value: unknown) =>
  typeof value === "string" && (value.includes("${") || value.startsWith("!") || isSecretName(variable));

const stdioServer = (context: DeriveContext, name: string, server: JsonObject): ServerSection => {
  if (!isJsonObject(server.env)) {
    return { value: [name, server], rules: [], notices: [] };
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
    notices: secret.map(
      (variable) =>
        `mcp ${name}: ${variable} is a placeholder in the sandbox; add credentials.rules for the host it calls`,
    ),
  };
};

const serverSection = (
  context: DeriveContext,
  name: string,
  server: unknown,
  signedIn: string[],
): ServerSection => {
  if (!isJsonObject(server)) {
    return { value: [name, server], rules: [], notices: [] };
  }

  if (isHttpServer(server)) {
    return httpServer(context, name, server, signedIn);
  }

  return isStdioServer(server)
    ? stdioServer(context, name, server)
    : { value: [name, server], rules: [], notices: [] };
};

export const deriveMcp = (
  context: DeriveContext,
  mcp: JsonObject,
  signedIn: string[],
): Section<JsonObject> => {
  const merged = mergeSections(
    Object.entries(objectOr(mcp.mcpServers)).map(([name, server]) =>
      serverSection(context, name, server, signedIn),
    ),
  );

  return {
    value: { ...mcp, mcpServers: Object.fromEntries(merged.values) },
    rules: merged.rules,
    notices: merged.notices,
  };
};
