import { timingSafeEqual } from "node:crypto";

const PROXY_USER = "pi-sandbox";

const CONTROL_USER = "pi-sandbox-control";

export type ProxyCaller = { kind: "repo"; token: string } | { kind: "control"; token: string };

const basic = (user: string, token: string) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

export const proxyAuthorization = (token: string) => basic(PROXY_USER, token);

export const controlAuthorization = (token: string) => basic(CONTROL_USER, token);

export const guestProxyUrl = (route: { address: string }, token: string) =>
  `http://${PROXY_USER}:${token}@${route.address}`;

export const sameText = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
};

export const parseProxyAuthorization = (header: string | string[] | undefined): ProxyCaller | undefined => {
  const match = typeof header === "string" ? /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim()) : null;
  const decoded = match === null ? "" : Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const user = decoded.slice(0, separator);
  const token = decoded.slice(separator + 1);

  if (separator === -1 || token === "") {
    return undefined;
  }

  if (user === PROXY_USER) {
    return { kind: "repo", token };
  }

  return user === CONTROL_USER ? { kind: "control", token } : undefined;
};
