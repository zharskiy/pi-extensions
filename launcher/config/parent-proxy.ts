type Env = Record<string, string | undefined>;

export type ParentProxyTarget =
  | { unsupported: string }
  | { host: string; port: number; hasCredentials: boolean; credentials?: string; noProxy: string[] };

const DEFAULT_PARENT_PORT = 80;

const setOf = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

const listOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const decoded = (url: URL) => {
  try {
    return `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  } catch {
    return undefined;
  }
};

const httpTarget = (url: URL, env: Env): ParentProxyTarget => {
  const hasCredentials = url.username !== "" || url.password !== "";
  const credentials = hasCredentials ? decoded(url) : undefined;

  if (hasCredentials && credentials === undefined) {
    return { unsupported: "HTTPS_PROXY holds credentials that are not URL-encoded" };
  }

  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port || DEFAULT_PARENT_PORT),
    hasCredentials,
    ...(credentials === undefined ? {} : { credentials }),
    noProxy: listOf(setOf(env.NO_PROXY) ?? env.no_proxy),
  };
};

export const parentProxyOf = (env: Env): ParentProxyTarget | undefined => {
  const text = setOf(env.HTTPS_PROXY) ?? setOf(env.https_proxy);

  if (text === undefined) {
    return undefined;
  }

  if (!URL.canParse(text)) {
    return { unsupported: "HTTPS_PROXY is not a URL" };
  }

  const url = new URL(text);

  return url.protocol === "http:"
    ? httpTarget(url, env)
    : {
        unsupported: `HTTPS_PROXY uses ${url.protocol.slice(0, -1)}, only http parent proxies are supported`,
      };
};
