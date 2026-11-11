import type { IncomingMessage, ServerResponse } from "node:http";
import { type Denials, denialBody } from "./denials.ts";
import { sendJson } from "./replies.ts";
import { HTTP_PORT, parseAuthority } from "./request-target.ts";

const UNPARSEABLE = "unparseable";

export const PLAIN_HTTP = { rule: "plain-http", reason: "only HTTPS through CONNECT is proxied" };

export const hostOf = (authority: string | undefined) =>
  parseAuthority(authority, HTTP_PORT)?.host ?? UNPARSEABLE;

const pathOf = (url: string | undefined) => (url?.startsWith("/") ? (url.split("?")[0] ?? "") : "");

const sinceOf = (url: string) => {
  const since = Number(new URL(url, "http://proxy").searchParams.get("since") ?? "0");

  return Number.isFinite(since) ? since : 0;
};

export const createRoutes = (denials: Denials) => {
  const refusePlain = (request: IncomingMessage, response: ServerResponse) => {
    const target = parseAuthority(request.headers.host, HTTP_PORT);
    const host = target?.host ?? UNPARSEABLE;

    denials.note(host, PLAIN_HTTP, { port: target?.port ?? HTTP_PORT });

    sendJson(response, 403, denialBody(host, PLAIN_HTTP));
  };

  return (request: IncomingMessage, response: ServerResponse) => {
    const path = pathOf(request.url);

    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { ok: true, pid: process.pid });

      return;
    }

    if (request.method === "GET" && path === "/denials") {
      sendJson(response, 200, { denials: denials.since(sinceOf(request.url ?? "/")) });

      return;
    }

    refusePlain(request, response);
  };
};
