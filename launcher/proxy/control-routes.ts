import type { IncomingMessage, ServerResponse } from "node:http";
import { isJsonObject } from "../shared/index.ts";
import type { ControlMessage, ControlReply } from "./control.ts";
import { type DenialContext, type Denials, denialBody } from "./denials.ts";
import type { EgressPolicy } from "./policy.ts";
import { PROXY_AGENT, readLimited, sendJson, sendJsonAndClose } from "./replies.ts";
import type { VaultHook, VaultReply } from "./vault/index.ts";
import { OAUTH_ROUTES } from "./vault/protocol.ts";

export type Caller = { kind: "repo"; repoHash: string } | { kind: "control" };

interface ControlRouteOptions {
  policy: EgressPolicy;
  policyHash: string;
  denials: Denials;
  onControl?: (message: ControlMessage) => ControlReply | Promise<ControlReply>;
  vault?: VaultHook;
}

const MAX_CONTROL_BYTES = 1024 * 1024;

const TOKEN_HASH = /^[0-9a-f]{64}$/;

const OAUTH_PATHS = new Set<string>(Object.values(OAUTH_ROUTES));

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

const tokenHashOf = (value: unknown) =>
  typeof value === "string" && TOKEN_HASH.test(value) ? { repoTokenHash: value } : {};

const parseControlMessage = (text: string | undefined): ControlMessage | undefined => {
  try {
    const message = JSON.parse(text ?? "") as { type?: unknown; secrets?: unknown; repoTokenHash?: unknown };

    return message.type === "env-secrets" && isStringMap(message.secrets)
      ? { type: "env-secrets", secrets: message.secrets, ...tokenHashOf(message.repoTokenHash) }
      : undefined;
  } catch {
    return undefined;
  }
};

const sinceOf = (url: string) => {
  const since = Number(new URL(url, "http://proxy").searchParams.get("since") ?? "0");

  return Number.isFinite(since) ? since : 0;
};

const flowOf = (url: string | undefined) =>
  new URL(url ?? "/", "http://proxy").searchParams.get("flow") ?? "";

const parseJsonBody = (text: string | undefined): unknown => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
};

const sendReply = (response: ServerResponse, reply: VaultReply) => {
  if (reply.body === undefined) {
    response.writeHead(reply.status, { "proxy-agent": PROXY_AGENT });

    response.end();

    return;
  }

  sendJson(response, reply.status, reply.body);
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

  const oauthReply = async (
    request: IncomingMessage,
    response: ServerResponse,
    vault: VaultHook,
    repoHash: string,
  ): Promise<VaultReply & { close?: boolean }> => {
    const path = pathOf(request.url);

    if (request.method === "POST" && path === OAUTH_ROUTES.open) {
      const body = await readBody(request);

      if (body.overflow) {
        return { status: 413, body: { ok: false, error: "pi-sandbox: request body too large" }, close: true };
      }

      return vault.open(repoHash, parseJsonBody(body.text));
    }

    if (request.method === "GET" && path === OAUTH_ROUTES.callback) {
      const abort = new AbortController();

      response.once("close", () => abort.abort());

      return vault.callback(repoHash, flowOf(request.url), abort.signal);
    }

    if (request.method === "POST" && path === OAUTH_ROUTES.cancel) {
      return vault.cancel(repoHash, flowOf(request.url));
    }

    return { status: 405, body: { ok: false, error: "pi-sandbox: method not allowed" } };
  };

  const handleOAuth = async (request: IncomingMessage, response: ServerResponse, caller: Caller) => {
    if (caller.kind !== "repo") {
      sendJson(response, 403, {
        ok: false,
        error: "pi-sandbox: sign-in routes need the sandbox's proxy token",
      });

      return;
    }

    if (options.vault === undefined) {
      sendJson(response, 404, { ok: false, error: "pi-sandbox: sign-in from the sandbox is not enabled" });

      return;
    }

    const reply = await oauthReply(request, response, options.vault, caller.repoHash);

    if (reply.close === true) {
      sendJsonAndClose(response, reply.status, reply.body ?? {});

      return;
    }

    sendReply(response, reply);
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

    if (OAUTH_PATHS.has(path)) {
      await handleOAuth(request, response, caller);

      return;
    }

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
