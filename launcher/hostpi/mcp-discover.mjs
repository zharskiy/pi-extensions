import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const MCP_PACKAGE = join("@earendil-works", "pi-mcp");

const REQUEST_TIMEOUT_MS = 15_000;

const CLIENT_INFO = { name: "pi-sandbox", version: "1.0.0" };

const packageDirFrom = (start) => {
  const candidate = join(start, "node_modules", MCP_PACKAGE);

  if (existsSync(join(candidate, "package.json"))) {
    return candidate;
  }

  const parent = dirname(start);

  return parent === start ? undefined : packageDirFrom(parent);
};

const moduleOf = (packageDir, subpath) => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const target = manifest.exports?.[subpath]?.import;

  if (typeof target !== "string") {
    throw new Error(`${packageDir}: no ${subpath} export`);
  }

  return import(pathToFileURL(join(packageDir, target)).href);
};

const readStdin = () =>
  new Promise((resolve, reject) => {
    const chunks = [];

    process.stdin.on("data", (chunk) => chunks.push(chunk));

    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));

    process.stdin.once("error", reject);
  });

const timedFetch = (input, init = {}) =>
  fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const initializeBody = (protocolVersion) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO },
  });

const challengeOf = async (oauth, url, protocolVersion) => {
  const response = await timedFetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: initializeBody(protocolVersion),
  }).catch(() => undefined);

  void response?.body?.cancel().catch(() => undefined);

  return oauth.parseWwwAuthenticate(response?.headers.get("www-authenticate") ?? undefined);
};

const hostOf = (value) => {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();

  return url.port === "" ? host : `${host}:${url.port}`;
};

const endpointsOf = (info) => {
  const issuer = String(info.authorizationServerUrl);
  const metadata = info.authorizationServerMetadata;

  return {
    issuer,
    authorizationEndpoint: metadata?.authorization_endpoint ?? new URL("/authorize", issuer).href,
    tokenEndpoint: metadata?.token_endpoint ?? new URL("/token", issuer).href,
    registrationEndpoint:
      metadata === undefined ? new URL("/register", issuer).href : metadata.registration_endpoint,
  };
};

const discover = async (oauth, protocolVersion, request) => {
  const challenge = await challengeOf(oauth, request.url, protocolVersion);
  const metadataUrl =
    request.authServerMetadataUrl === undefined ? undefined : new URL(request.authServerMetadataUrl);
  const info = await oauth.discoverOAuthServerInfo(request.url, {
    resourceMetadataUrl: challenge.resourceMetadataUrl,
    authorizationServerMetadataUrl: metadataUrl,
    fetch: timedFetch,
  });
  const endpoints = endpointsOf(info);
  const resource = oauth.selectResource(request.url, info.resourceMetadata);
  const resourceMetadataUrl = challenge.resourceMetadataUrl?.href;
  const hosts = [
    resourceMetadataUrl ?? request.url,
    endpoints.issuer,
    endpoints.tokenEndpoint,
    endpoints.registrationEndpoint,
    metadataUrl?.href,
  ]
    .filter((value) => value !== undefined)
    .map(hostOf);

  return {
    ok: true,
    url: request.url,
    ...endpoints,
    ...(resource === undefined ? {} : { resource }),
    ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    hosts: [...new Set(hosts)].sort(),
    piState: { ...info, ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }) },
  };
};

const parseRequest = (text) => {
  const value = JSON.parse(text);

  if (typeof value?.url !== "string") {
    throw new Error("expected {url, authServerMetadataUrl?} on stdin");
  }

  return typeof value.authServerMetadataUrl === "string"
    ? { url: value.url, authServerMetadataUrl: value.authServerMetadataUrl }
    : { url: value.url };
};

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const main = async (piPackageDir) => {
  const packageDir = packageDirFrom(piPackageDir);

  if (packageDir === undefined) {
    throw new Error(`${piPackageDir}: ${MCP_PACKAGE} not found`);
  }

  const request = parseRequest(await readStdin());
  const root = await moduleOf(packageDir, ".");
  const oauth = await moduleOf(packageDir, "./oauth");
  const result = await discover(oauth, root.LATEST_PROTOCOL_VERSION, request).catch((error) => ({
    ok: false,
    url: request.url,
    error: messageOf(error),
  }));

  process.stdout.write(`${JSON.stringify(result)}\n`);
};

main(process.argv[2] ?? process.cwd()).catch((error) => {
  process.stderr.write(`${messageOf(error)}\n`);

  process.exitCode = 1;
});
