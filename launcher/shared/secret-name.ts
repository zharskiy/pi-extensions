import { looksLikeJwt } from "./placeholder.ts";

const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|JWT)/i;

export const isSecretName = (name: string) => SECRET_NAME.test(name);

export const isAuthLikeHeader = (name: string) => {
  const lower = name.toLowerCase();

  return lower !== "proxy-authorization" && (lower === "authorization" || isSecretName(lower));
};

export const hasUrlUserinfo = (url: unknown) => {
  const parts = typeof url === "string" && URL.canParse(url) ? new URL(url) : undefined;

  return parts !== undefined && (parts.username !== "" || parts.password !== "");
};

const SCHEME_PREFIX = /^(bearer|basic|token)\s+\S/i;

export const isSecretShapedValue = (value: string) =>
  SCHEME_PREFIX.test(value.trim()) || looksLikeJwt(value.trim()) || hasUrlUserinfo(value);
