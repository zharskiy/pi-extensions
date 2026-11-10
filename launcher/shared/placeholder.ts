import { sha256Hex } from "./hash.ts";
import { type JsonObject, parseJsonObject } from "./json-file.ts";

export const PLACEHOLDER_PREFIX = "pi-sandbox-";

const HEX_LENGTH = 24;

const OPAQUE = new RegExp(`^${PLACEHOLDER_PREFIX}[0-9a-f]{${HEX_LENGTH}}$`);

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

const PLACEHOLDER_HEADER = { alg: "none", typ: "JWT" };

const CHANGING_CLAIMS = new Set(["exp", "iat", "nbf", "jti", "auth_time"]);

const decodeSegment = (segment: string) => Buffer.from(segment, "base64url").toString("utf8");

const encodeSegment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const isJsonText = (text: string) => parseJsonObject(text) !== undefined;

export const placeholderFor = (salt: string, identity: string) =>
  `${PLACEHOLDER_PREFIX}${sha256Hex(salt + identity).slice(0, HEX_LENGTH)}`;

export const looksLikeJwt = (value: string) => {
  if (!JWT.test(value)) {
    return false;
  }

  const [header = "", payload = ""] = value.split(".");

  return isJsonText(decodeSegment(header)) && isJsonText(decodeSegment(payload));
};

const lastingClaims = (payload: JsonObject) =>
  Object.fromEntries(Object.entries(payload).filter(([claim]) => !CHANGING_CLAIMS.has(claim)));

export const jwtShapedPlaceholder = (token: string, salt: string, identity: string) => {
  const opaque = placeholderFor(salt, identity);

  if (!looksLikeJwt(token)) {
    return opaque;
  }

  const payload = parseJsonObject(decodeSegment(token.split(".")[1] ?? "")) ?? {};

  return [
    encodeSegment(PLACEHOLDER_HEADER),
    encodeSegment(lastingClaims(payload)),
    Buffer.from(opaque).toString("base64url"),
  ].join(".");
};

export const isPlaceholder = (value: string) => {
  if (OPAQUE.test(value)) {
    return true;
  }

  const signature = value.split(".")[2];

  return looksLikeJwt(value) && signature !== undefined && OPAQUE.test(decodeSegment(signature));
};
