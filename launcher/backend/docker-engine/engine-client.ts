import { createWriteStream } from "node:fs";
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
}

interface EngineResponse {
  status: number;
  body: Buffer;
}

export interface Hijacked {
  socket: Socket;
  head: Buffer;
}

export interface EngineClient {
  readonly socketPath: string;
  call(request: EngineRequest, accepted?: number[]): Promise<EngineResponse>;
  json<T>(request: EngineRequest, accepted?: number[]): Promise<T>;
  progress(request: EngineRequest): Promise<Array<Record<string, unknown>>>;
  download(request: EngineRequest, path: string): Promise<void>;
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

const parseLines = (body: Buffer) =>
  body
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const progressError = (lines: Array<Record<string, unknown>>) => {
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

export const createEngineClient = (socketPath: string): EngineClient => {
  const failure = (error: NodeJS.ErrnoException) =>
    CONNECTION_ERRORS.has(error.code ?? "")
      ? new LauncherError(
          `engine socket ${socketPath} is not reachable (${error.code})`,
          "start the runtime, for example colima start --profile pi-sandbox",
        )
      : new LauncherError(`engine: ${error.message}`);

  const open = (request: EngineRequest, extra: Record<string, string> = {}) =>
    httpRequest({
      socketPath,
      method: request.method,
      path: urlOf(request),
      headers: headersOf(request, extra),
    });

  const send = (request: EngineRequest) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = open(request);

      outgoing.once("response", resolve);

      outgoing.once("error", (error) => reject(failure(error)));

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

  const progress = async (request: EngineRequest) => {
    const lines = parseLines((await call(request)).body);
    const error = progressError(lines);

    if (error !== undefined) {
      throw new LauncherError(`engine: ${error}`);
    }

    return lines;
  };

  const download = async (request: EngineRequest, path: string) => {
    const response = await send(request);

    if (isFailure(response.statusCode ?? 0, [])) {
      throw engineError(request, await collect(response));
    }

    await pipeline(response, createWriteStream(path));
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

  return { socketPath, call, json, progress, download, upgrade };
};
