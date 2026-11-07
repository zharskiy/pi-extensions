import { readFile } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { getCACertificates } from "node:tls";
import {
  errorMessage,
  LauncherError,
  readJsonFile,
  sha256Hex,
  stateLayout,
  writeFileAtomic,
  writeJsonFile,
} from "../shared/index.ts";
import type { FetchText, FetchTextResult, LayerConfig, OrgLayerInput, OrgLayerResult } from "./types.ts";
import { validateLayer } from "./validate.ts";

interface OrgCache {
  text: string;
  fetchedAt: number;
}

interface OrgMeta {
  source?: unknown;
  fetchedAt?: unknown;
  sha256?: unknown;
}

const DEFAULT_REFRESH_HOURS = 24;

const HOUR_MS = 3_600_000;

const FETCH_TIMEOUT_MS = 3000;

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

const cacheFiles = (stateDir: string) => {
  const dir = stateLayout(stateDir).org;

  return { baseline: join(dir, "baseline.json"), meta: join(dir, "meta.json") };
};

const readCache = async (input: OrgLayerInput): Promise<OrgCache | undefined> => {
  const files = cacheFiles(input.stateDir);
  const meta = await readJsonFile<OrgMeta>(files.meta).catch(() => undefined);
  const text = await readFile(files.baseline, "utf8").catch(() => undefined);

  if (meta === undefined || text === undefined || typeof meta.fetchedAt !== "number") {
    return undefined;
  }

  const hash = sha256Hex(text);
  const intact = meta.source === input.ref.source && meta.sha256 === hash;
  const pinned = input.ref.sha256;

  return intact && (pinned === undefined || pinned === hash)
    ? { text, fetchedAt: meta.fetchedAt }
    : undefined;
};

const writeCache = async (input: OrgLayerInput, text: string) => {
  const files = cacheFiles(input.stateDir);

  await writeFileAtomic(files.baseline, text);

  await writeJsonFile(files.meta, {
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

  return response.body;
};

const fetchFresh = async (input: OrgLayerInput) => {
  const text = await fetchBaseline(input).catch((error: unknown) => {
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

const loadFromUrl = async (input: OrgLayerInput): Promise<OrgLayerResult> => {
  const cache = await readCache(input);
  const refreshMs = (input.ref.refreshHours ?? DEFAULT_REFRESH_HOURS) * HOUR_MS;

  if (cache !== undefined && input.now() - cache.fetchedAt < refreshMs) {
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

    return { layer: parseLayer(cache.text), notices: [fallbackNotice(cache, error)] };
  }
};

const loadFromFile = async (input: OrgLayerInput): Promise<OrgLayerResult> => {
  const text = await readFile(input.ref.source, "utf8").catch((error: unknown) => {
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

const requestOnce = (url: URL, signal: AbortSignal) =>
  new Promise<HttpsResponse>((resolve, reject) => {
    const request = get(url, { ca: trustedCas(), signal }, (response) => {
      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer) => chunks.push(chunk));

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

const follow = async (url: URL, signal: AbortSignal, redirects: number): Promise<FetchTextResult> => {
  if (url.protocol !== "https:") {
    throw new Error("only HTTPS URLs are fetched");
  }

  const response = await requestOnce(url, signal);

  if (!REDIRECT_STATUSES.includes(response.status) || response.location === undefined) {
    return { status: response.status, body: response.body };
  }

  if (redirects >= MAX_REDIRECTS) {
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  }

  return follow(new URL(response.location, url), signal, redirects + 1);
};

export const httpsFetchText: FetchText = async (url, options) => {
  const signal = AbortSignal.timeout(options.timeoutMs);

  try {
    return await follow(new URL(url), signal, 0);
  } catch (error) {
    throw signal.aborted ? new Error(`timed out after ${options.timeoutMs} ms`) : error;
  }
};
