import { readFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { get, type RequestOptions } from "node:https";
import { getCACertificates } from "node:tls";
import {
  errorMessage,
  expandHome,
  LauncherError,
  readJsonObject,
  sha256Hex,
  stateLayout,
  writeFileAtomic,
  writeJsonFile,
} from "../shared/index.ts";
import type {
  FetchText,
  FetchTextResult,
  LayerConfig,
  OrgLayerInput,
  OrgLayerResult,
  OrgRef,
} from "./types.ts";
import { validateLayer } from "./validate.ts";

interface OrgCache {
  text: string;
  fetchedAt: number;
  failedAt?: number;
}

interface OrgMeta {
  source?: unknown;
  fetchedAt?: unknown;
  sha256?: unknown;
  failedAt?: unknown;
}

type CacheState =
  | { state: "missing" | "otherSource" | "damaged" | "unpinned" }
  | { state: "intact"; cache: OrgCache; hash: string };

interface OrgStatusInput {
  ref: OrgRef;
  stateDir: string;
  now: () => number;
  home?: string;
}

export interface OrgBaselineStatus {
  ok: boolean;
  message: string;
}

export type HttpsGet = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

const DEFAULT_REFRESH_HOURS = 24;

const HOUR_MS = 3_600_000;

const RETRY_MS = HOUR_MS;

const FETCH_TIMEOUT_MS = 3000;

const MAX_RESPONSE_BYTES = 1_048_576;

const OVERSIZE = "org: response larger than 1 MiB";

const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

const isUrl = (source: string) => source.startsWith("https://");

const displaySource = (source: string) => {
  if (!isUrl(source)) {
    return source;
  }

  const url = new URL(source);

  return `${url.origin}${url.pathname}`;
};

const inspectCache = async (stateDir: string, ref: OrgRef): Promise<CacheState> => {
  const layout = stateLayout(stateDir);
  const meta: OrgMeta | undefined = await readJsonObject(layout.orgMeta);
  const text = await readFile(layout.orgBaseline, "utf8").catch(() => undefined);

  if (meta === undefined || text === undefined || typeof meta.fetchedAt !== "number") {
    return { state: "missing" };
  }

  if (meta.source !== ref.source) {
    return { state: "otherSource" };
  }

  const hash = sha256Hex(text);

  if (meta.sha256 !== hash) {
    return { state: "damaged" };
  }

  if (ref.sha256 !== undefined && ref.sha256 !== hash) {
    return { state: "unpinned" };
  }

  const failedAt = typeof meta.failedAt === "number" ? meta.failedAt : undefined;

  return { state: "intact", cache: { text, fetchedAt: meta.fetchedAt, failedAt }, hash };
};

const readCache = async (input: OrgLayerInput) => {
  const inspected = await inspectCache(input.stateDir, input.ref);

  return inspected.state === "intact" ? inspected.cache : undefined;
};

const recordFailure = async (input: OrgLayerInput) => {
  const file = stateLayout(input.stateDir).orgMeta;
  const meta = await readJsonObject(file);

  await writeJsonFile(file, { ...meta, failedAt: input.now() }).catch(() => undefined);
};

const writeCache = async (input: OrgLayerInput, text: string) => {
  const layout = stateLayout(input.stateDir);

  await writeFileAtomic(layout.orgBaseline, text);

  await writeJsonFile(layout.orgMeta, {
    source: input.ref.source,
    fetchedAt: input.now(),
    sha256: sha256Hex(text),
  });
};

const BASELINE_HINT = "ask your administrator to fix the org baseline";

const parseLayer = (text: string): LayerConfig => {
  try {
    return validateLayer(JSON.parse(text) as unknown, "org");
  } catch (error) {
    const message =
      error instanceof SyntaxError ? `org: invalid JSON (${error.message})` : errorMessage(error);

    throw new LauncherError(message, BASELINE_HINT);
  }
};

const assertPinned = (input: OrgLayerInput, text: string) => {
  const pinned = input.ref.sha256;

  if (pinned !== undefined && sha256Hex(text) !== pinned) {
    throw new LauncherError(
      `org: the baseline from ${displaySource(input.ref.source)} does not match the pinned sha256`,
      "ask your administrator for the current sha256, or fix org.sha256 in the config",
    );
  }
};

const fetchBaseline = async (input: OrgLayerInput) => {
  const response = await input.fetchText(input.ref.source, { timeoutMs: FETCH_TIMEOUT_MS });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (Buffer.byteLength(response.body) > MAX_RESPONSE_BYTES) {
    throw new LauncherError(OVERSIZE, BASELINE_HINT);
  }

  return response.body;
};

const fetchFresh = async (input: OrgLayerInput) => {
  const text = await fetchBaseline(input).catch((error: unknown) => {
    if (error instanceof LauncherError) {
      throw error;
    }

    throw new LauncherError(
      `org: could not fetch the baseline from ${displaySource(input.ref.source)} (${errorMessage(error)})`,
      "check the network or org.source in the config",
    );
  });

  assertPinned(input, text);

  return { text, layer: parseLayer(text) };
};

const fallbackNotice = (cache: OrgCache, error: unknown) =>
  `${errorMessage(error)}; using the copy fetched at ${new Date(cache.fetchedAt).toISOString()}`;

const isSettled = (input: OrgLayerInput, cache: OrgCache) => {
  const refreshMs = (input.ref.refreshHours ?? DEFAULT_REFRESH_HOURS) * HOUR_MS;
  const now = input.now();

  return (
    now - cache.fetchedAt < refreshMs || (cache.failedAt !== undefined && now - cache.failedAt < RETRY_MS)
  );
};

const offlineResult = (input: OrgLayerInput, cache: OrgCache | undefined): OrgLayerResult =>
  cache === undefined
    ? {
        layer: undefined,
        notices: [
          `org: no cached baseline from ${displaySource(input.ref.source)}; the org layer is skipped`,
        ],
      }
    : { layer: parseLayer(cache.text), notices: [] };

const loadFromUrl = async (input: OrgLayerInput): Promise<OrgLayerResult> => {
  const cache = await readCache(input);

  if (input.offline === true) {
    return offlineResult(input, cache);
  }

  if (cache !== undefined && isSettled(input, cache)) {
    return { layer: parseLayer(cache.text), notices: [] };
  }

  try {
    const fresh = await fetchFresh(input);

    await writeCache(input, fresh.text);

    return { layer: fresh.layer, notices: [] };
  } catch (error) {
    if (cache === undefined) {
      throw error;
    }

    await recordFailure(input);

    return { layer: parseLayer(cache.text), notices: [fallbackNotice(cache, error)] };
  }
};

const loadFromFile = async (input: OrgLayerInput): Promise<OrgLayerResult> => {
  const text = await readFile(expandHome(input.ref.source, input.home), "utf8").catch((error: unknown) => {
    throw new LauncherError(
      `org: cannot read ${input.ref.source} (${errorMessage(error)})`,
      "fix org.source in the config",
    );
  });

  assertPinned(input, text);

  return { layer: parseLayer(text), notices: [] };
};

export const loadOrgLayer = (input: OrgLayerInput): Promise<OrgLayerResult> =>
  isUrl(input.ref.source) ? loadFromUrl(input) : loadFromFile(input);

const trustedCas = () => [...new Set([...getCACertificates("default"), ...getCACertificates("system")])];

interface HttpsResponse extends FetchTextResult {
  location?: string;
}

const requestOnce = (httpsGet: HttpsGet, url: URL, signal: AbortSignal) =>
  new Promise<HttpsResponse>((resolve, reject) => {
    const request = httpsGet(url, { ca: trustedCas(), signal }, (response) => {
      const chunks: Buffer[] = [];
      const received = { bytes: 0 };

      response.on("data", (chunk: Buffer) => {
        received.bytes += chunk.length;

        if (received.bytes > MAX_RESPONSE_BYTES) {
          reject(new LauncherError(OVERSIZE, BASELINE_HINT));

          request.destroy();

          return;
        }

        chunks.push(chunk);
      });

      response.on("error", reject);

      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          location: response.headers.location,
        }),
      );
    });

    request.on("error", reject);
  });

const follow = async (
  httpsGet: HttpsGet,
  url: URL,
  signal: AbortSignal,
  redirects: number,
): Promise<FetchTextResult> => {
  if (url.protocol !== "https:") {
    throw new Error("only HTTPS URLs are fetched");
  }

  const response = await requestOnce(httpsGet, url, signal);

  if (!REDIRECT_STATUSES.includes(response.status) || response.location === undefined) {
    return { status: response.status, body: response.body };
  }

  if (redirects >= MAX_REDIRECTS) {
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  }

  return follow(httpsGet, new URL(response.location, url), signal, redirects + 1);
};

export const createHttpsFetchText =
  (httpsGet: HttpsGet = get): FetchText =>
  async (url, options) => {
    const signal = AbortSignal.timeout(options.timeoutMs);

    try {
      return await follow(httpsGet, new URL(url), signal, 0);
    } catch (error) {
      throw signal.aborted ? new Error(`timed out after ${options.timeoutMs} ms`) : error;
    }
  };

export const httpsFetchText = createHttpsFetchText();

const SHORT_HASH = 12;

const failedStatus = (message: string): OrgBaselineStatus => ({ ok: false, message });

const fileStatus = async (input: OrgStatusInput): Promise<OrgBaselineStatus> => {
  const source = input.ref.source;
  const text = await readFile(expandHome(source, input.home), "utf8").catch(() => undefined);

  if (text === undefined) {
    return failedStatus(`cannot read ${source}`);
  }

  const hash = sha256Hex(text);

  if (input.ref.sha256 !== undefined && input.ref.sha256 !== hash) {
    return failedStatus(`${source} does not match the pinned sha256`);
  }

  try {
    parseLayer(text);
  } catch (error) {
    return failedStatus(`${source}: ${errorMessage(error)}`);
  }

  return { ok: true, message: `${source}, sha256 ${hash.slice(0, SHORT_HASH)}` };
};

const CACHE_PROBLEMS = {
  missing: "has not been fetched",
  otherSource: "has not been fetched since org.source changed",
  damaged: "has a damaged cached copy",
  unpinned: "has a cached copy that does not match the pinned sha256",
};

const urlStatus = async (input: OrgStatusInput): Promise<OrgBaselineStatus> => {
  const source = displaySource(input.ref.source);
  const inspected = await inspectCache(input.stateDir, input.ref);

  if (inspected.state !== "intact") {
    return failedStatus(`${source} ${CACHE_PROBLEMS[inspected.state]}`);
  }

  const hours = Math.floor((input.now() - inspected.cache.fetchedAt) / HOUR_MS);

  return {
    ok: true,
    message: `${source} fetched ${hours} h ago, sha256 ${inspected.hash.slice(0, SHORT_HASH)}`,
  };
};

export const orgBaselineStatus = (input: OrgStatusInput): Promise<OrgBaselineStatus> =>
  isUrl(input.ref.source) ? urlStatus(input) : fileStatus(input);
