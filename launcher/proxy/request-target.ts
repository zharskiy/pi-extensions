import { normalizeHost, TLS_PORT } from "../config/index.ts";

export type RequestTarget = { ok: true; path: string; decodedPath: string } | { ok: false; reason: string };

const ABSOLUTE = /^https:\/\/([^/?#]*)(.*)$/is;

const SEPARATOR = /[/\\]/;

const refused = (reason: string): RequestTarget => ({ ok: false, reason });

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

const isDotSegment = (segment: string) => segment === "." || segment === "..";

export const HTTP_PORT = 80;

const WRITTEN_PORT = /:\d+$/;

export interface Authority {
  host: string;
  port: number;
}

export const parseAuthority = (
  authority: string | undefined,
  defaultPort?: number,
): Authority | undefined => {
  const text = authority ?? "";

  try {
    const url = new URL(`http://${text}`);
    const plain =
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      !text.includes("@");
    const written = url.port !== "" ? Number(url.port) : WRITTEN_PORT.test(text) ? HTTP_PORT : undefined;
    const port = written ?? defaultPort;

    return plain && port !== undefined ? { host: url.hostname, port } : undefined;
  } catch {
    return undefined;
  }
};

const sameAuthority = (authority: string, host: string, port: number) => {
  const parsed = parseAuthority(authority, TLS_PORT);

  return parsed !== undefined && normalizeHost(parsed.host) === normalizeHost(host) && parsed.port === port;
};

const originFormOf = (target: string, host: string, port: number) => {
  if (target.startsWith("/")) {
    return target;
  }

  const absolute = ABSOLUTE.exec(target);

  if (absolute === null || !sameAuthority(absolute[1] ?? "", host, port)) {
    return undefined;
  }

  const rest = absolute[2] ?? "";

  return rest.startsWith("/") ? rest : `/${rest}`;
};

export const parseRequestTarget = (target: string | undefined, host: string, port: number): RequestTarget => {
  const path = originFormOf(target ?? "", host, port);

  if (path === undefined) {
    return refused("pi-sandbox: the request target must be a path on the terminated host");
  }

  const decodedPath = decode((path.split("#")[0] ?? "").split("?")[0] ?? "");

  if (decodedPath === undefined) {
    return refused("pi-sandbox: the request path is not valid percent-encoding");
  }

  if (decodedPath.split(SEPARATOR).some(isDotSegment)) {
    return refused("pi-sandbox: the request path holds a dot segment");
  }

  return { ok: true, path, decodedPath };
};
