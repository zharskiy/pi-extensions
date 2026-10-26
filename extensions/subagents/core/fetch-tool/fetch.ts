import { errorText } from "../../../../platform/shared/index.ts";
import { mediaType, pageText, supported } from "./text.ts";

type FetchLimits = { timeoutSeconds: number; maxBytes: number; maxChars: number };

export type FetchedPage = {
  url: string;
  status: number;
  reason: string;
  title?: string;
  text: string;
  chars: { shown: number; total: number };
  bytesCut: boolean;
};

type Body = { bytes: Uint8Array; cut: boolean };

const join = (chunks: Uint8Array[], size: number) =>
  chunks.reduce(
    (state, chunk) => {
      state.bytes.set(chunk, state.at);

      return { bytes: state.bytes, at: state.at + chunk.length };
    },
    { bytes: new Uint8Array(size), at: 0 },
  ).bytes;

const readBody = async (stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Body> => {
  if (!stream) {
    return { bytes: new Uint8Array(0), cut: false };
  }

  const reader = stream.getReader();

  const next = async (chunks: Uint8Array[], size: number): Promise<Body> => {
    const { done, value } = await reader.read();

    if (done) {
      return { bytes: join(chunks, size), cut: false };
    }

    const room = maxBytes - size;

    if (value.length > room) {
      await reader.cancel();

      return { bytes: join([...chunks, value.subarray(0, room)], maxBytes), cut: true };
    }

    return next([...chunks, value], size + value.length);
  };

  return next([], 0);
};

const decode = (bytes: Uint8Array, contentType: string) => {
  const label = /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1] ?? "utf-8";

  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

const parse = (url: string) => {
  try {
    return new URL(url);
  } catch {
    throw new Error("not a valid URL");
  }
};

const failure = (error: unknown, caller: AbortSignal | undefined, timer: AbortSignal, seconds: number) => {
  if (caller?.aborted) {
    return new Error("aborted");
  }

  if (timer.aborted) {
    return new Error(`timed out after ${seconds} s`);
  }

  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = errorText(error);

  if (/redirect/i.test(cause) || /redirect/i.test(message)) {
    return new Error("too many redirects");
  }

  return new Error(cause === "" ? message : `${message}: ${cause}`);
};

export const fetchPage = async (
  url: string,
  limits: FetchLimits,
  signal?: AbortSignal,
): Promise<FetchedPage> => {
  const target = parse(url);

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`only http and https URLs are supported, got ${target.protocol.replace(":", "")}`);
  }

  const timer = AbortSignal.timeout(limits.timeoutSeconds * 1000);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;

  try {
    const response = await fetch(target.href, { redirect: "follow", signal: combined });
    const contentType = response.headers.get("content-type") ?? "";

    if (!supported(contentType)) {
      await response.body?.cancel();

      throw new Error(`unsupported content type ${mediaType(contentType)}`);
    }

    const body = await readBody(response.body, limits.maxBytes);
    const page = pageText(decode(body.bytes, contentType), contentType);

    return {
      url: response.url === "" ? target.href : response.url,
      status: response.status,
      reason: response.statusText,
      title: page.title,
      text: page.text.slice(0, limits.maxChars),
      chars: { shown: Math.min(page.text.length, limits.maxChars), total: page.text.length },
      bytesCut: body.cut,
    };
  } catch (error) {
    if (!combined.aborted && error instanceof Error && error.message.startsWith("unsupported content type")) {
      throw error;
    }

    throw failure(error, signal, timer, limits.timeoutSeconds);
  }
};
