import { timingSafeEqual } from "node:crypto";

const PROXY_USER = "pi-sandbox";

export const BASIC_HEADER = /^Basic\s+([A-Za-z0-9+/=]+)$/i;

export const basicAuthorization = (credentials: string) =>
  `Basic ${Buffer.from(credentials).toString("base64")}`;

export const proxyAuthorization = (token: string) => basicAuthorization(`${PROXY_USER}:${token}`);

export const guestProxyUrl = (route: { address: string }, token: string) =>
  `http://${PROXY_USER}:${token}@${route.address}`;

export const sameText = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
};

export const proxyTokenOf = (header: string | string[] | undefined): string | undefined => {
  const match = typeof header === "string" ? BASIC_HEADER.exec(header.trim()) : null;
  const decoded = match === null ? "" : Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const token = decoded.slice(separator + 1);

  return separator === -1 || token === "" || decoded.slice(0, separator) !== PROXY_USER ? undefined : token;
};
