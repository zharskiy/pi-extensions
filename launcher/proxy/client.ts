import { request as httpRequest } from "node:http";
import { type JsonObject, parseJsonObject } from "../shared/index.ts";
import { controlAuthorization, proxyAuthorization } from "./auth.ts";
import type { DenialRecord } from "./dynamic.ts";
import type { ProxyInstance } from "./files.ts";

interface EnvSecretsMessage {
  type: "env-secrets";
  secrets: Record<string, string>;
  repoTokenHash?: string;
}

export type ControlMessage = EnvSecretsMessage;

export type ControlReply = { ok: true } | { ok: false; error: string };

export interface Health {
  ok: boolean;
  policyHash: string;
  pid: number;
}

interface ProxyAsk {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs: number;
}

type ProxyAnswer = { ok: true; status: number; body: JsonObject | undefined } | { ok: false; error: string };

const LISTEN_HOST = "127.0.0.1";

const HEALTH_TIMEOUT_MS = 500;

const CONTROL_TIMEOUT_MS = 2000;

const DENIALS_TIMEOUT_MS = 1000;

const UNREADABLE = "the proxy sent an unreadable reply";

const bodyHeaders = (body: string | undefined) =>
  body === undefined
    ? {}
    : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };

const askProxy = (port: number, authorization: string, ask: ProxyAsk) =>
  new Promise<ProxyAnswer>((resolve) => {
    const body = ask.body === undefined ? undefined : JSON.stringify(ask.body);
    const request = httpRequest(
      {
        host: LISTEN_HOST,
        port,
        method: ask.method,
        path: ask.path,
        timeout: ask.timeoutMs,
        headers: { "proxy-authorization": authorization, ...bodyHeaders(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));

        response.on("error", (error) => resolve({ ok: false, error: error.message }));

        response.on("end", () =>
          resolve({
            ok: true,
            status: response.statusCode ?? 0,
            body: parseJsonObject(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );

    request.on("timeout", () => request.destroy(new Error("timed out")));

    request.on("error", (error) => resolve({ ok: false, error: error.message }));

    request.end(body);
  });

export const readHealth = async (instance: ProxyInstance): Promise<Health | undefined> => {
  const answer = await askProxy(instance.port, controlAuthorization(instance.token), {
    method: "GET",
    path: "/healthz",
    timeoutMs: HEALTH_TIMEOUT_MS,
  });

  return answer.ok && answer.status === 200 && answer.body?.ok === true
    ? (answer.body as unknown as Health)
    : undefined;
};

export const sendProxyControl = async (
  instance: ProxyInstance,
  message: ControlMessage,
): Promise<ControlReply> => {
  const answer = await askProxy(instance.port, controlAuthorization(instance.token), {
    method: "POST",
    path: "/control",
    body: message,
    timeoutMs: CONTROL_TIMEOUT_MS,
  });

  if (!answer.ok) {
    return { ok: false, error: `cannot reach the proxy: ${answer.error}` };
  }

  return typeof answer.body?.ok === "boolean"
    ? (answer.body as unknown as ControlReply)
    : { ok: false, error: UNREADABLE };
};

export const fetchDenials = async (
  instance: ProxyInstance,
  token: string,
  since: number,
): Promise<DenialRecord[]> => {
  const answer = await askProxy(instance.port, proxyAuthorization(token), {
    method: "GET",
    path: `/denials?since=${since}`,
    timeoutMs: DENIALS_TIMEOUT_MS,
  });
  const denials = answer.ok && answer.status === 200 ? answer.body?.denials : undefined;

  return Array.isArray(denials) ? (denials as DenialRecord[]) : [];
};
