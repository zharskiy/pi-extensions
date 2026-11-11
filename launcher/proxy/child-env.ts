type Env = Record<string, string | undefined>;

const PASSED = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GH_CONFIG_DIR",
  "GLAB_CONFIG_DIR",
  "XDG_CONFIG_HOME",
];

const PROXY_URLS = ["HTTPS_PROXY", "https_proxy"];

const NO_PROXY = ["NO_PROXY", "no_proxy"];

const present = (entries: Array<[string, string | undefined]>) =>
  Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== undefined));

const withoutUserinfo = (text: string) => {
  try {
    const url = new URL(text);

    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return undefined;
  }
};

export const minimalEnv = (env: Env) => present(PASSED.map((name) => [name, env[name]]));

export const parentProxyEnv = (env: Env) =>
  present([
    ...PROXY_URLS.map((name): [string, string | undefined] => [
      name,
      env[name] === undefined || env[name] === "" ? undefined : withoutUserinfo(env[name]),
    ]),
    ...NO_PROXY.map((name): [string, string | undefined] => [name, env[name]]),
  ]);

const withUserinfo = (text: string, auth: string) => {
  const colon = auth.indexOf(":");

  try {
    const url = new URL(text);

    url.username = encodeURIComponent(colon < 0 ? auth : auth.slice(0, colon));

    url.password = colon < 0 ? "" : encodeURIComponent(auth.slice(colon + 1));

    return url.href;
  } catch {
    return text;
  }
};

export const helperProxyEnv = (parentEnv: Record<string, string>, parentAuth: string | undefined) =>
  Object.fromEntries(
    Object.entries(parentEnv).map(([name, value]) => [
      name,
      parentAuth !== undefined && PROXY_URLS.includes(name) ? withUserinfo(value, parentAuth) : value,
    ]),
  );
