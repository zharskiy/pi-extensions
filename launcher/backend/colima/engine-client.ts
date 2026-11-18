import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LauncherError } from "../../shared/index.ts";
import { ENGINE_PROFILE, logHint, plainStart } from "./profile.ts";

interface EngineRequest {
  method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string | number | boolean>;
  json?: unknown;
  stream?: Readable;
  contentType?: string;
  timeoutMs?: number;
}

interface EngineResponse {
  status: number;
  body: Buffer;
}

type ProgressLine = Record<string, unknown>;

export interface Hijacked {
  socket: Socket;
  head: Buffer;
}

export interface EngineClient {
  call(request: EngineRequest, accepted?: number[]): Promise<EngineResponse>;
  json<T>(request: EngineRequest, accepted?: number[]): Promise<T>;
  progress(request: EngineRequest, onLine?: (line: ProgressLine) => void): Promise<void>;
  upgrade(request: EngineRequest): Promise<Hijacked>;
}

export const segment = (value: string) => encodeURIComponent(value);

export class EngineTimeout extends LauncherError {}

const CONNECTION_ERRORS = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK", "ECONNRESET"]);

const PING_PATH = "/_ping";

const CONTAINERS_PATH = "/containers/";

const TIMED_OUT = "ETIMEDOUT_ENGINE";

const urlOf = (request: EngineRequest) => {
  const entries = Object.entries(request.query ?? {}).map(([key, value]): [string, string] => [
    key,
    String(value),
  ]);

  return entries.length === 0 ? request.path : `${request.path}?${new URLSearchParams(entries)}`;
};

const contentTypeOf = (request: EngineRequest) =>
  request.contentType ?? (request.json === undefined ? undefined : "application/json");

const headersOf = (request: EngineRequest, extra: Record<string, string>) => {
  const contentType = contentTypeOf(request);

  return contentType === undefined ? extra : { ...extra, "Content-Type": contentType };
};

export const messageOf = (body: Buffer) => {
  const text = body.toString("utf8").trim();

  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
};

export const engineError = (request: Pick<EngineRequest, "method" | "path">, response: EngineResponse) =>
  new LauncherError(
    `engine: ${request.method} ${request.path} failed (${response.status}): ${messageOf(response.body)}`,
  );

const collect = async (response: IncomingMessage): Promise<EngineResponse> => ({
  status: response.statusCode ?? 0,
  body: Buffer.concat((await response.toArray()) as Buffer[]),
});

const isFailure = (status: number, accepted: number[]) => status >= 400 && !accepted.includes(status);

const parseLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProgressLine);

const errorOf = (line: ProgressLine) =>
  line.error === undefined && line.errorDetail === undefined
    ? undefined
    : String(line.error ?? JSON.stringify(line.errorDetail));

const readLines = (
  response: IncomingMessage,
  onLine: (line: ProgressLine) => void,
  streamFailure: (error: NodeJS.ErrnoException) => Error,
) =>
  new Promise<string | undefined>((resolve, reject) => {
    const state: { rest: string; error?: string } = { rest: "" };

    const take = (text: string) => {
      parseLines(text).forEach((line) => {
        state.error ??= errorOf(line);

        onLine(line);
      });
    };

    const guarded = (action: () => void) => {
      try {
        action();
      } catch (error) {
        response.destroy();

        reject(error);
      }
    };

    response.setEncoding("utf8");

    response.on("data", (chunk: string) =>
      guarded(() => {
        const text = state.rest + chunk;
        const end = text.lastIndexOf("\n") + 1;

        state.rest = text.slice(end);

        take(text.slice(0, end));
      }),
    );

    response.once("end", () =>
      guarded(() => {
        take(state.rest);

        resolve(state.error);
      }),
    );

    response.once("error", (error) => reject(streamFailure(error)));
  });

const writeBody = (outgoing: ClientRequest, request: EngineRequest) => {
  if (request.stream !== undefined) {
    pipeline(request.stream, outgoing).catch((error: Error) => outgoing.destroy(error));

    return;
  }

  outgoing.end(request.json === undefined ? undefined : JSON.stringify(request.json));
};

export interface EngineTimeouts {
  callMs: number;
  pingMs: number;
  removalMs: number;
}

export const ENGINE_TIMEOUTS: EngineTimeouts = { callMs: 30_000, pingMs: 5000, removalMs: 600_000 };

const RETRY_HINT = `the engine may still be finishing it; run the command again later, and see ${logHint(ENGINE_PROFILE)} if it keeps timing out`;

export const createEngineClient = (
  socket: () => string,
  timeouts: EngineTimeouts = ENGINE_TIMEOUTS,
): EngineClient => {
  const failure = (error: NodeJS.ErrnoException, request: EngineRequest, answered = false) => {
    if (error.code === TIMED_OUT) {
      return new EngineTimeout(
        `engine socket ${socket()} did not answer ${request.method} ${request.path}: ${error.message}`,
        RETRY_HINT,
      );
    }

    if (answered) {
      return new LauncherError(
        `engine socket ${socket()} closed ${request.method} ${request.path} before its answer was complete (${error.code ?? error.message})`,
        RETRY_HINT,
      );
    }

    return CONNECTION_ERRORS.has(error.code ?? "")
      ? new LauncherError(
          `engine socket ${socket()} is not reachable (${error.code})`,
          `run ${plainStart(ENGINE_PROFILE)}`,
        )
      : new LauncherError(`engine: ${error.message}`);
  };

  const timedOut = (ms: number) =>
    Object.assign(new Error(`no answer within ${ms / 1000} s`), { code: TIMED_OUT });

  const open = (request: EngineRequest, extra: Record<string, string> = {}) =>
    httpRequest({
      socketPath: socket(),
      method: request.method,
      path: urlOf(request),
      headers: headersOf(request, extra),
    });

  const send = (request: EngineRequest, timeoutMs = request.timeoutMs) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = open(request);
      const answer: { response?: IncomingMessage } = {};

      outgoing.once("response", (response) => {
        answer.response = response;

        resolve(response);
      });

      outgoing.once("error", (error) => reject(failure(error, request)));

      if (timeoutMs !== undefined) {
        outgoing.setTimeout(timeoutMs, () => {
          const error = timedOut(timeoutMs);

          answer.response?.destroy(error);

          outgoing.destroy(error);
        });
      }

      writeBody(outgoing, request);
    });

  const collected = (response: IncomingMessage, request: EngineRequest) =>
    collect(response).catch((error: NodeJS.ErrnoException) => Promise.reject(failure(error, request, true)));

  const defaultTimeout = (request: EngineRequest) => {
    if (request.path === PING_PATH) {
      return timeouts.pingMs;
    }

    return request.method === "DELETE" && !request.path.startsWith(CONTAINERS_PATH)
      ? timeouts.removalMs
      : timeouts.callMs;
  };

  const call = async (request: EngineRequest, accepted: number[] = []) => {
    const response = await collected(
      await send(request, request.timeoutMs ?? defaultTimeout(request)),
      request,
    );

    if (isFailure(response.status, accepted)) {
      throw engineError(request, response);
    }

    return response;
  };

  const json = async <T>(request: EngineRequest, accepted: number[] = []) => {
    const response = await call(request, accepted);

    return (response.body.length === 0 ? undefined : JSON.parse(response.body.toString("utf8"))) as T;
  };

  const progress = async (request: EngineRequest, onLine: (line: ProgressLine) => void = () => undefined) => {
    const response = await send(request);

    if (isFailure(response.statusCode ?? 0, [])) {
      throw engineError(request, await collected(response, request));
    }

    const error = await readLines(response, onLine, (failed) => failure(failed, request, true));

    if (error !== undefined) {
      throw new LauncherError(`engine: ${error}`);
    }
  };

  const upgrade = (request: EngineRequest) =>
    new Promise<Hijacked>((resolve, reject) => {
      const outgoing = open(request, { Connection: "Upgrade", Upgrade: "tcp" });

      outgoing.once("upgrade", (_response, socket, head) => resolve({ socket, head }));

      outgoing.once("response", (response) => {
        collect(response).then((collected) => reject(engineError(request, collected)), reject);
      });

      outgoing.once("error", (error) => reject(failure(error, request)));

      writeBody(outgoing, request);
    });

  return { call, json, progress, upgrade };
};
