import type { IncomingMessage, ServerResponse } from "node:http";
import { type Denials, denialBody } from "./denials.ts";
import { sendJson } from "./replies.ts";

const UNPARSEABLE = "unparseable";

export const hostOf = (authority: string | undefined) => {
  try {
    const url = new URL(`http://${authority ?? ""}`);
    const valid = url.username === "" && url.password === "" && url.pathname === "/" && url.search === "";

    return valid && url.hostname !== "" ? url.hostname : UNPARSEABLE;
  } catch {
    return UNPARSEABLE;
  }
};

const pathOf = (url: string | undefined) => (url?.startsWith("/") ? (url.split("?")[0] ?? "") : "");

const sinceOf = (url: string) => {
  const since = Number(new URL(url, "http://proxy").searchParams.get("since") ?? "0");

  return Number.isFinite(since) ? since : 0;
};

export const createRoutes = (repoHash: string, denials: Denials) => {
  const refusePlain = (request: IncomingMessage, response: ServerResponse) => {
    const host = hostOf(request.headers.host);
    const denial = { rule: "plain-http", reason: "only HTTPS through CONNECT is proxied" };

    denials.note(host, denial, { repoHash, port: 80 });

    sendJson(response, 403, denialBody(host, denial));
  };

  return (request: IncomingMessage, response: ServerResponse) => {
    const path = pathOf(request.url);

    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { ok: true, pid: process.pid });

      return;
    }

    if (request.method === "GET" && path === "/denials") {
      sendJson(response, 200, { denials: denials.since(repoHash, sinceOf(request.url ?? "/")) });

      return;
    }

    refusePlain(request, response);
  };
};
