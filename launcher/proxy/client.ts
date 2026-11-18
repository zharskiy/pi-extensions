import { request as httpRequest } from "node:http";
import { type JsonObject, parseJsonObject } from "../shared/index.ts";
import { proxyAuthorization } from "./auth.ts";

export interface DenialRecord {
  time: number;
  host: string;
  port: number;
  repoHash: string;
  rule: string;
  reason: string;
  credentialRule?: string;
}

interface Health {
  ok: boolean;
  pid: number;
}

interface ProxyAsk {
  path: string;
  timeoutMs: number;
}

type ProxyAnswer = { ok: true; status: number; body: JsonObject | undefined } | { ok: false; error: string };

const LISTEN_HOST = "127.0.0.1";

const HEALTH_TIMEOUT_MS = 500;

const DENIALS_TIMEOUT_MS = 1000;

const askProxy = (port: number, token: string, ask: ProxyAsk) =>
  new Promise<ProxyAnswer>((resolve) => {
    const request = httpRequest(
      {
        host: LISTEN_HOST,
        port,
        method: "GET",
        path: ask.path,
        timeout: ask.timeoutMs,
        headers: { "proxy-authorization": proxyAuthorization(token) },
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

    request.end();
  });

export const readHealth = async (port: number, token: string): Promise<Health | undefined> => {
  const answer = await askProxy(port, token, { path: "/healthz", timeoutMs: HEALTH_TIMEOUT_MS });

  return answer.ok && answer.status === 200 && answer.body?.ok === true
    ? (answer.body as unknown as Health)
    : undefined;
};

export const fetchDenials = async (port: number, token: string, since: number): Promise<DenialRecord[]> => {
  const answer = await askProxy(port, token, {
    path: `/denials?since=${since}`,
    timeoutMs: DENIALS_TIMEOUT_MS,
  });
  const denials = answer.ok && answer.status === 200 ? answer.body?.denials : undefined;

  return Array.isArray(denials) ? (denials as DenialRecord[]) : [];
};
