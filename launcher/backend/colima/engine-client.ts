import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LauncherError } from "../../shared/index.ts";

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
  progress(request: EngineRequest, onLine?: (line: ProgressLine) => void): Promise<ProgressLine[]>;
  upgrade(request: EngineRequest): Promise<Hijacked>;
}

export const segment = (value: string) => encodeURIComponent(value);

const CONNECTION_ERRORS = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK", "ECONNRESET"]);

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

const readLines = (response: IncomingMessage, onLine: (line: ProgressLine) => void) =>
  new Promise<ProgressLine[]>((resolve, reject) => {
    const state = { rest: "", lines: [] as ProgressLine[] };

    const take = (text: string) => {
      const parsed = parseLines(text);

      state.lines.push(...parsed);

      parsed.forEach(onLine);
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

        resolve(state.lines);
      }),
    );

    response.once("error", reject);
  });

const progressError = (lines: ProgressLine[]) => {
  const failed = lines.find((line) => line.error !== undefined || line.errorDetail !== undefined);

  return failed === undefined ? undefined : String(failed.error ?? JSON.stringify(failed.errorDetail));
};

const writeBody = (outgoing: ClientRequest, request: EngineRequest) => {
  if (request.stream !== undefined) {
    pipeline(request.stream, outgoing).catch((error: Error) => outgoing.destroy(error));

    return;
  }

  outgoing.end(request.json === undefined ? undefined : JSON.stringify(request.json));
};

export const createEngineClient = (socket: () => string): EngineClient => {
  const failure = (error: NodeJS.ErrnoException) =>
    CONNECTION_ERRORS.has(error.code ?? "")
      ? new LauncherError(
          `engine socket ${socket()} is not reachable (${error.code})`,
          "start the runtime, for example colima start --profile pi-sandbox",
        )
      : new LauncherError(`engine: ${error.message}`);

  const open = (request: EngineRequest, extra: Record<string, string> = {}) =>
    httpRequest({
      socketPath: socket(),
      method: request.method,
      path: urlOf(request),
      headers: headersOf(request, extra),
    });

  const send = (request: EngineRequest) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = open(request);

      outgoing.once("response", resolve);

      outgoing.once("error", (error) => reject(failure(error)));

      if (request.timeoutMs !== undefined) {
        outgoing.setTimeout(request.timeoutMs, () => outgoing.destroy(new Error("timed out")));
      }

      writeBody(outgoing, request);
    });

  const call = async (request: EngineRequest, accepted: number[] = []) => {
    const response = await collect(await send(request));

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
      throw engineError(request, await collect(response));
    }

    const lines = await readLines(response, onLine);
    const error = progressError(lines);

    if (error !== undefined) {
      throw new LauncherError(`engine: ${error}`);
    }

    return lines;
  };

  const upgrade = (request: EngineRequest) =>
    new Promise<Hijacked>((resolve, reject) => {
      const outgoing = open(request, { Connection: "Upgrade", Upgrade: "tcp" });

      outgoing.once("upgrade", (_response, socket, head) => resolve({ socket, head }));

      outgoing.once("response", (response) => {
        collect(response).then((collected) => reject(engineError(request, collected)), reject);
      });

      outgoing.once("error", (error) => reject(failure(error)));

      writeBody(outgoing, request);
    });

  return { call, json, progress, upgrade };
};
