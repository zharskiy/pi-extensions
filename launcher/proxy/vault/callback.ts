import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  codePlaceholder,
  OAUTH_CALLBACK_STATUS,
  type OAuthCallbackReply,
  type OAuthCancelReply,
  type OAuthOpenReply,
} from "../../shared/index.ts";

export interface FlowInput {
  repoHash: string;
  server: string;
  state: string;
  redirectUri: string;
  path: string;
  port: number;
  scope?: string;
  tokenEndpoint: string;
}

export interface Flow extends FlowInput {
  id: string;
  expiresAt: number;
}

export interface VaultReply {
  status: number;
  body?: OAuthOpenReply | OAuthCallbackReply | OAuthCancelReply;
}

export interface FlowOptions {
  now: () => number;
  ttlMs: number;
  pollMs: number;
}

type Phase = "pending" | "ready" | "gone";

interface Live {
  flow: Flow;
  phase: Phase;
  query?: string;
  code?: { real: string; placeholder: string };
  listener?: Server;
  waiters: Set<() => void>;
  timer?: NodeJS.Timeout;
}

export type StartResult = { ok: true; flow: Flow } | { ok: false; status: number; error: string };

const LISTEN_HOST = "127.0.0.1";

const FLOW_BYTES = 16;

const TEXT = { "content-type": "text/plain; charset=utf-8", connection: "close" };

const UNKNOWN_FLOW = "pi-sandbox: no such sign-in";

export const createFlows = (options: FlowOptions) => {
  const flows = new Map<string, Live>();

  const notify = (live: Live) => {
    const waiters = [...live.waiters];

    live.waiters.clear();

    waiters.forEach((wake) => {
      wake();
    });
  };

  const closeListener = (live: Live) =>
    new Promise<void>((resolve) => {
      const listener = live.listener;

      if (listener === undefined) {
        resolve();

        return;
      }

      live.listener = undefined;

      listener.close(() => resolve());

      listener.closeAllConnections();
    });

  const end = async (live: Live) => {
    clearTimeout(live.timer);

    live.phase = "gone";

    notify(live);

    await closeListener(live);

    setTimeout(() => flows.delete(live.flow.id), options.ttlMs).unref();
  };

  const isCallback = (live: Live, request: IncomingMessage, url: URL) =>
    live.phase === "pending" &&
    request.method === "GET" &&
    url.pathname === live.flow.path &&
    url.searchParams.get("state") === live.flow.state;

  const handle = (live: Live, request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${LISTEN_HOST}`);

    if (!isCallback(live, request, url)) {
      response.writeHead(400, TEXT).end("pi-sandbox: this is not the pending sign-in callback");

      return;
    }

    const code = url.searchParams.get("code");

    if (code !== null && code !== "") {
      const placeholder = codePlaceholder();

      live.code = { real: code, placeholder };

      url.searchParams.set("code", placeholder);
    }

    live.query = url.searchParams.toString();

    live.phase = "ready";

    notify(live);

    response.once("finish", () => void closeListener(live));

    response
      .writeHead(200, TEXT)
      .end(live.code === undefined ? "Sign-in failed. Return to pi." : "Signed in. Return to pi.");
  };

  const bind = (live: Live) =>
    new Promise<string | undefined>((resolve) => {
      const listener = createServer((request, response) => handle(live, request, response));

      listener.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));

      listener.listen(live.flow.port, LISTEN_HOST, () => {
        live.listener = listener;

        resolve(undefined);
      });
    });

  const replaced = (input: FlowInput) =>
    [...flows.values()].filter(
      (live) =>
        live.phase !== "gone" && live.flow.repoHash === input.repoHash && live.flow.server === input.server,
    );

  const start = async (input: FlowInput): Promise<StartResult> => {
    await Promise.all(replaced(input).map(end));

    const flow: Flow = {
      ...input,
      id: randomBytes(FLOW_BYTES).toString("hex"),
      expiresAt: options.now() + options.ttlMs,
    };
    const live: Live = { flow, phase: "pending", waiters: new Set() };
    const failure = await bind(live);

    if (failure === "EADDRINUSE") {
      return {
        ok: false,
        status: 409,
        error: `pi-sandbox: port ${input.port} is in use on the host; close the program using it and sign in again`,
      };
    }

    if (failure !== undefined) {
      return { ok: false, status: 502, error: `pi-sandbox: cannot listen on port ${input.port}: ${failure}` };
    }

    live.timer = setTimeout(() => void end(live), options.ttlMs);

    live.timer.unref();

    flows.set(flow.id, live);

    return { ok: true, flow };
  };

  const owned = (repoHash: string, id: string) => {
    const live = flows.get(id);

    return live?.flow.repoHash === repoHash ? live : undefined;
  };

  const waitForChange = (live: Live, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);

        live.waiters.delete(done);

        signal?.removeEventListener("abort", done);

        resolve();
      };
      const timer = setTimeout(done, options.pollMs);

      live.waiters.add(done);

      signal?.addEventListener("abort", done, { once: true });
    });

  const replyOf = (live: Live): VaultReply => {
    if (live.phase === "ready") {
      return { status: OAUTH_CALLBACK_STATUS.ready, body: { status: "ready", query: live.query ?? "" } };
    }

    return live.phase === "pending"
      ? { status: OAUTH_CALLBACK_STATUS.pending }
      : { status: OAUTH_CALLBACK_STATUS.gone, body: { status: "gone" } };
  };

  const poll = async (repoHash: string, id: string, signal?: AbortSignal): Promise<VaultReply> => {
    const live = owned(repoHash, id);

    if (live === undefined) {
      return { status: 404, body: { status: "gone", error: UNKNOWN_FLOW } };
    }

    if (live.phase === "pending") {
      await waitForChange(live, signal);
    }

    return replyOf(live);
  };

  const cancel = async (repoHash: string, id: string): Promise<VaultReply> => {
    const live = owned(repoHash, id);

    if (live === undefined) {
      return { status: 404, body: { ok: false, error: UNKNOWN_FLOW } };
    }

    await end(live);

    return { status: 200, body: { ok: true } };
  };

  const byCode = (placeholder: string) => {
    const live = [...flows.values()].find(
      (entry) => entry.phase === "ready" && entry.code?.placeholder === placeholder,
    );

    return live?.code === undefined ? undefined : { flow: live.flow, code: live.code.real };
  };

  const finish = async (id: string) => {
    const live = flows.get(id);

    if (live !== undefined) {
      await end(live);
    }
  };

  const close = async () => {
    await Promise.all([...flows.values()].map(end));

    flows.clear();
  };

  return { start, poll, cancel, byCode, finish, close };
};

export type Flows = ReturnType<typeof createFlows>;
