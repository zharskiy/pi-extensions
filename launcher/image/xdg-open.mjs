#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { Agent, request } from "node:http";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

export const ROUTES = { open: "/oauth/open", callback: "/oauth/callback", cancel: "/oauth/cancel" };

export const CALLBACK_STATUS = { ready: 200, pending: 204, gone: 410 };

export const HEALTH_ROUTE = "/healthz";

export const CHECK_FLAG = "--pi-sandbox-check";

const USAGE_EXIT = 3;

const POLL_TIMEOUT_MS = 35_000;

const REQUEST_TIMEOUT_MS = 15_000;

const PROBE_TIMEOUT_MS = 2_000;

const LOOPBACK = "127.0.0.1";

const PREFIX = "pi-sandbox:";

const proxyOf = (env) => {
  const value = env.HTTPS_PROXY ?? env.https_proxy;

  if (value === undefined || value === "") {
    throw new Error("HTTPS_PROXY is not set, so the sandbox proxy cannot be reached");
  }

  const url = new URL(value);
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;

  return {
    host: url.hostname,
    port: Number(url.port || 80),
    authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
  };
};

const send = (proxy, method, path, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = request(
      {
        host: proxy.host,
        port: proxy.port,
        method,
        path,
        agent: new Agent(),
        timeout: timeoutMs,
        headers: {
          "proxy-authorization": proxy.authorization,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": payload.length }),
        },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));

        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );

        response.once("error", reject);
      },
    );

    outgoing.once("timeout", () => outgoing.destroy(new Error(`${path} timed out`)));

    outgoing.once("error", reject);

    outgoing.end(payload);
  });

const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

const failure = (reply) => {
  const error = jsonOf(reply.text).error;

  return new Error(typeof error === "string" ? error : `the sandbox proxy answered ${reply.status}`);
};

const isListening = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port, timeout: PROBE_TIMEOUT_MS });

    socket.once("connect", () => {
      socket.destroy();

      resolve(true);
    });

    socket.once("timeout", () => {
      socket.destroy();

      resolve(true);
    });

    socket.once("error", () => resolve(false));
  });

const replay = (flow, query) =>
  new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: LOOPBACK,
        port: flow.port,
        method: "GET",
        path: `${flow.path}?${query}`,
        agent: new Agent(),
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        response.resume();

        response.once("end", resolve);
      },
    );

    outgoing.once("timeout", () => outgoing.destroy(new Error("pi's sign-in listener did not answer")));

    outgoing.once("error", reject);

    outgoing.end();
  });

const flowPath = (route, flow) => `${route}?flow=${encodeURIComponent(flow.flow)}`;

const poll = async (proxy, flow) => {
  const reply = await send(proxy, "GET", flowPath(ROUTES.callback, flow), undefined, POLL_TIMEOUT_MS);

  if (reply.status === CALLBACK_STATUS.ready) {
    const query = jsonOf(reply.text).query;

    if (typeof query !== "string") {
      throw new Error("the sandbox proxy sent a callback without a query");
    }

    await replay(flow, query);

    return;
  }

  if (reply.status !== CALLBACK_STATUS.pending) {
    throw failure(reply);
  }

  if (!(await isListening(flow.port))) {
    await send(proxy, "POST", flowPath(ROUTES.cancel, flow), undefined, REQUEST_TIMEOUT_MS).catch(
      () => undefined,
    );

    return;
  }

  return poll(proxy, flow);
};

const openFlow = async (proxy, url) => {
  const reply = await send(proxy, "POST", ROUTES.open, { url }, REQUEST_TIMEOUT_MS);
  const body = jsonOf(reply.text);

  if (reply.status !== 200 || typeof body.flow !== "string" || typeof body.port !== "number") {
    throw failure(reply);
  }

  return { flow: body.flow, port: body.port, path: typeof body.path === "string" ? body.path : "/" };
};

const check = async (proxy) => {
  const reply = await send(proxy, "GET", HEALTH_ROUTE, undefined, REQUEST_TIMEOUT_MS);

  if (reply.status !== 200) {
    throw failure(reply);
  }

  process.stdout.write("ok\n");
};

const httpsUrl = (args) => {
  const [value] = args;

  if (args.length !== 1 || !URL.canParse(value)) {
    return undefined;
  }

  return new URL(value).protocol === "https:" ? value : undefined;
};

const main = async (args, env) => {
  if (args.length === 1 && args[0] === CHECK_FLAG) {
    await check(proxyOf(env));

    return 0;
  }

  const url = httpsUrl(args);

  if (url === undefined) {
    process.stderr.write(`${PREFIX} xdg-open in the sandbox opens exactly one https: URL\n`);

    return USAGE_EXIT;
  }

  const proxy = proxyOf(env);

  await poll(proxy, await openFlow(proxy, url));

  return 0;
};

const messageOf = (error) => {
  const message = error instanceof Error ? error.message : String(error);

  return message.startsWith(PREFIX) ? message : `${PREFIX} ${message}`;
};

const isEntry = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (isEntry()) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${messageOf(error)}\n`);

      process.exitCode = 1;
    },
  );
}
