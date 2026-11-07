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

const sameAuthority = (authority: string, host: string, port: number) => {
  try {
    const url = new URL(`https://${authority}`);
    const urlPort = url.port === "" ? TLS_PORT : Number(url.port);

    return (
      url.username === "" &&
      url.password === "" &&
      normalizeHost(url.hostname) === normalizeHost(host) &&
      urlPort === port
    );
  } catch {
    return false;
  }
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
