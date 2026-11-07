import { OAUTH_AUTHORIZE_PARAMS, type VaultDiscovered, type VaultServer } from "../../shared/index.ts";

export interface OpenCandidate {
  server: VaultServer;
  discovery: VaultDiscovered;
}

interface AuthorizeRequest {
  candidate: OpenCandidate;
  url: string;
  state: string;
  redirectUri: string;
  port: number;
  path: string;
  scope?: string;
}

export type OpenCheck =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; status: number; error: string };

const MAX_URL_BYTES = 8 * 1024;

const MIN_EPHEMERAL_PORT = 32_768;

const MAX_PORT = 65_535;

const CALLBACK_PATH = /^\/callback(\/[A-Za-z0-9_-]+)?$/;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

const ALLOWED_PARAMS = new Set<string>(OAUTH_AUTHORIZE_PARAMS);

const OPEN_LIMIT = 5;

const OPEN_WINDOW_MS = 10 * 60_000;

const refuse = (status: number, error: string): OpenCheck => ({
  ok: false,
  status,
  error: `pi-sandbox: ${error}`,
});

const parseUrl = (text: string) => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

const endpointOf = (url: URL) => `${url.origin}${url.pathname}`;

const endpointKey = (text: string) => {
  const url = parseUrl(text);

  return url === undefined ? undefined : endpointOf(url);
};

const configuredCallback = (server: VaultServer) => {
  const oauth = server.oauth ?? {};
  const url = typeof oauth.callbackUrl === "string" ? parseUrl(oauth.callbackUrl) : undefined;
  const fixedPort = typeof oauth.callbackPort === "number" ? oauth.callbackPort : undefined;

  return { port: url?.port ? Number(url.port) : fixedPort, path: url?.pathname };
};

const isPlainLoopback = (url: URL) =>
  url.protocol === "http:" &&
  LOOPBACK_HOSTS.has(url.hostname) &&
  url.username === "" &&
  url.password === "" &&
  url.search === "" &&
  url.hash === "" &&
  url.port !== "";

const checkRedirect = (text: string | null, server: VaultServer) => {
  const url = text === null ? undefined : parseUrl(text);

  if (url === undefined || !isPlainLoopback(url)) {
    return undefined;
  }

  const configured = configuredCallback(server);
  const port = Number(url.port);
  const portAllowed =
    configured.port === undefined ? port >= MIN_EPHEMERAL_PORT && port <= MAX_PORT : port === configured.port;
  const pathAllowed = url.pathname === configured.path || CALLBACK_PATH.test(url.pathname);

  return portAllowed && pathAllowed ? { port, path: url.pathname } : undefined;
};

const paramProblem = (url: URL) => {
  const names = [...url.searchParams.keys()];
  const unknown = names.find((name) => !ALLOWED_PARAMS.has(name));
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  const prompt = url.searchParams.get("prompt");

  if (unknown !== undefined) {
    return `the authorization URL carries an unexpected parameter ${unknown}`;
  }

  if (repeated !== undefined) {
    return `the authorization URL repeats the parameter ${repeated}`;
  }

  return prompt === null || prompt === "consent"
    ? undefined
    : "the authorization URL may only ask for prompt=consent";
};

const isPkceRequest = (params: URLSearchParams) =>
  params.get("response_type") === "code" &&
  params.get("code_challenge_method") === "S256" &&
  (params.get("code_challenge") ?? "") !== "" &&
  (params.get("state") ?? "") !== "" &&
  (params.get("client_id") ?? "") !== "";

const chooseCandidate = (url: URL, matches: OpenCandidate[]) => {
  const resource = url.searchParams.get("resource");

  return matches.length === 1
    ? matches
    : matches.filter((candidate) => resource !== null && candidate.discovery.resource === resource);
};

const shapeProblem = (text: unknown) => {
  if (typeof text !== "string") {
    return 'send {"url": "<authorization URL>"}';
  }

  if (Buffer.byteLength(text) > MAX_URL_BYTES) {
    return "the authorization URL is longer than 8 KiB";
  }

  const url = parseUrl(text);

  if (url === undefined || url.protocol !== "https:") {
    return "only https authorization URLs are opened";
  }

  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    return "the authorization URL must not carry credentials or a fragment";
  }

  return paramProblem(url);
};

export const checkAuthorizeUrl = (text: unknown, candidates: OpenCandidate[]): OpenCheck => {
  const problem = shapeProblem(text);

  if (problem !== undefined) {
    return refuse(400, problem);
  }

  const url = new URL(text as string);
  const matches = candidates.filter(
    (candidate) => endpointKey(candidate.discovery.authorizationEndpoint) === endpointOf(url),
  );

  if (matches.length === 0) {
    return refuse(
      400,
      `${url.host}${url.pathname} is not the authorization endpoint of a configured MCP server`,
    );
  }

  const chosen = chooseCandidate(url, matches);
  const [candidate] = chosen;

  if (candidate === undefined || chosen.length > 1) {
    return refuse(409, `${url.host} serves several MCP servers; sign in with pi mcp login <name>`);
  }

  if (!isPkceRequest(url.searchParams)) {
    return refuse(
      400,
      "the authorization URL needs response_type=code, a client_id, an S256 code_challenge and a state",
    );
  }

  const redirectUri = url.searchParams.get("redirect_uri");
  const redirect = checkRedirect(redirectUri, candidate.server);

  if (redirect === undefined || redirectUri === null) {
    return refuse(400, "the redirect_uri must be pi's loopback callback on 127.0.0.1 or localhost");
  }

  const scope = url.searchParams.get("scope");

  return {
    ok: true,
    request: {
      candidate,
      url: url.href,
      state: url.searchParams.get("state") ?? "",
      redirectUri,
      port: redirect.port,
      path: redirect.path,
      ...(scope === null ? {} : { scope }),
    },
  };
};

export const createOpenLimiter = (now: () => number) => {
  const opens = new Map<string, number[]>();

  return (repoHash: string) => {
    const recent = (opens.get(repoHash) ?? []).filter((time) => now() - time < OPEN_WINDOW_MS);

    if (recent.length >= OPEN_LIMIT) {
      opens.set(repoHash, recent);

      return false;
    }

    opens.set(repoHash, [...recent, now()]);

    return true;
  };
};
