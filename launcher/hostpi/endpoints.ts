import { isSecretName } from "../shared/index.ts";

export interface Endpoint {
  host: string;
  port?: number;
}

export type EndpointResult = { endpoint: Endpoint } | { local: string } | { invalid: true };

const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d+){3}|\[::1\]|::1|0\.0\.0\.0)$/;

const TLS_PORT = 443;

export const endpointOf = (url: unknown): EndpointResult => {
  if (typeof url !== "string") {
    return { invalid: true };
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (parsed.protocol !== "https:" || LOOPBACK.test(host)) {
      return { local: host };
    }

    const port = parsed.port === "" ? TLS_PORT : Number(parsed.port);

    return { endpoint: port === TLS_PORT ? { host } : { host, port } };
  } catch {
    return { invalid: true };
  }
};

export const endpointKey = (endpoint: Endpoint) =>
  endpoint.port === undefined ? endpoint.host : `${endpoint.host}:${endpoint.port}`;

export const uniqueEndpoints = (endpoints: Endpoint[]) => [
  ...new Map(endpoints.map((endpoint) => [endpointKey(endpoint), endpoint])).values(),
];

const parsed = (url: unknown) => (typeof url === "string" && URL.canParse(url) ? new URL(url) : undefined);

const SECRET_QUERY_NAME = /^(auth|sig|signature|pass|passwd|pwd)$/i;

export const hasQueryCredential = (url: unknown) =>
  [...(parsed(url)?.searchParams.keys() ?? [])].some(
    (name) => isSecretName(name) || SECRET_QUERY_NAME.test(name),
  );

export const hasUrlPassword = (url: unknown) => (parsed(url)?.password ?? "") !== "";

export const hasUrlUserinfo = (url: unknown) => {
  const parts = parsed(url);

  return parts !== undefined && (parts.username !== "" || parts.password !== "");
};

export const withoutUserinfo = (url: unknown) => {
  const parts = parsed(url);

  if (parts === undefined) {
    return "";
  }

  parts.username = "";

  parts.password = "";

  return parts.href;
};

export const strippedUrl = (label: string, key: string, url: unknown) =>
  hasUrlUserinfo(url)
    ? {
        value: withoutUserinfo(url),
        notices: [`${label}: ${key} carried user credentials; add a credentials.rules header rule`],
      }
    : { value: url, notices: [] };
