import type { IncomingMessage, ServerResponse } from "node:http";
import { isJsonObject } from "../shared/index.ts";
import type { ControlMessage, ControlReply } from "./control.ts";
import { type DenialContext, type Denials, denialBody } from "./denials.ts";
import type { EgressPolicy } from "./policy.ts";
import { readLimited, sendJson, sendJsonAndClose } from "./replies.ts";

export type Caller = { kind: "repo"; repoHash: string } | { kind: "control" };

interface ControlRouteOptions {
  policy: EgressPolicy;
  policyHash: string;
  denials: Denials;
  onControl?: (message: ControlMessage) => ControlReply | Promise<ControlReply>;
}

const MAX_CONTROL_BYTES = 1024 * 1024;

const TOKEN_HASH = /^[0-9a-f]{64}$/;

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

export const pathOf = (url: string | undefined) => (url?.startsWith("/") ? (url.split("?")[0] ?? "") : "");

const readBody = async (request: IncomingMessage) => {
  const limited = await readLimited(request, MAX_CONTROL_BYTES);

  return { text: limited.body?.toString("utf8"), overflow: limited.overflow };
};

const isStringMap = (value: unknown): value is Record<string, string> =>
  isJsonObject(value) && Object.values(value).every((entry) => typeof entry === "string");

const parseControlMessage = (text: string | undefined): ControlMessage | undefined => {
  try {
    const message = JSON.parse(text ?? "") as { type?: unknown; secrets?: unknown; repoTokenHash?: unknown };

    return message.type === "env-secrets" &&
      isStringMap(message.secrets) &&
      typeof message.repoTokenHash === "string" &&
      TOKEN_HASH.test(message.repoTokenHash)
      ? { type: "env-secrets", secrets: message.secrets, repoTokenHash: message.repoTokenHash }
      : undefined;
  } catch {
    return undefined;
  }
};

const sinceOf = (url: string) => {
  const since = Number(new URL(url, "http://proxy").searchParams.get("since") ?? "0");

  return Number.isFinite(since) ? since : 0;
};

export const createControlRoutes = (options: ControlRouteOptions) => {
  const handleControl = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);

    if (body.overflow) {
      sendJsonAndClose(response, 400, { ok: false, error: "control message too large" });

      return;
    }

    const message = parseControlMessage(body.text);

    if (message === undefined) {
      sendJson(response, 400, { ok: false, error: "unknown control message" });

      return;
    }

    const reply = (await options.onControl?.(message)) ?? {
      ok: false,
      error: "control messages are not accepted",
    };

    sendJson(response, reply.ok ? 200 : 400, reply);
  };

  const refusePlain = (request: IncomingMessage, response: ServerResponse, caller: Caller) => {
    const host = hostOf(request.headers.host);
    const denial = { rule: "plain-http", reason: "only HTTPS through CONNECT is proxied" };
    const context: DenialContext = caller.kind === "repo" ? { repoHash: caller.repoHash, port: 80 } : {};

    options.denials.note(host, denial, context);

    sendJson(response, 403, denialBody(host, denial));
  };

  return async (request: IncomingMessage, response: ServerResponse, caller: Caller) => {
    const path = pathOf(request.url);

    if (request.method === "GET" && path === "/healthz") {
      sendJson(response, 200, { ok: true, policyHash: options.policyHash, pid: process.pid });

      return;
    }

    if (request.method === "GET" && path === "/policy") {
      sendJson(response, 200, { ...options.policy, policyHash: options.policyHash });

      return;
    }

    if (request.method === "GET" && path === "/denials" && caller.kind === "repo") {
      sendJson(response, 200, {
        denials: options.denials.since(caller.repoHash, sinceOf(request.url ?? "/")),
      });

      return;
    }

    if (request.method === "POST" && path === "/control") {
      await handleControl(request, response);

      return;
    }

    refusePlain(request, response, caller);
  };
};
