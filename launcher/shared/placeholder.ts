import { sha256Hex } from "./hash.ts";
import { parseJsonObject } from "./json-file.ts";

export const PLACEHOLDER_PREFIX = "pi-sandbox-";

const HEX_LENGTH = 24;

const OPAQUE = new RegExp(`^${PLACEHOLDER_PREFIX}[0-9a-f]{${HEX_LENGTH}}$`);

const CODE_PREFIX = `${PLACEHOLDER_PREFIX}code-`;

const CODE_BYTES = 16;

const CODE = new RegExp(`^${CODE_PREFIX}[0-9a-f]{${CODE_BYTES * 2}}$`);

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

const decodeSegment = (segment: string) => Buffer.from(segment, "base64url").toString("utf8");

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

export const jwtShapedPlaceholder = (token: string, salt: string, identity: string) => {
  const opaque = placeholderFor(salt, identity);

  if (!looksLikeJwt(token)) {
    return opaque;
  }

  const [header, payload] = token.split(".");

  return `${header}.${payload}.${Buffer.from(opaque).toString("base64url")}`;
};

export const isPlaceholder = (value: string) => {
  if (OPAQUE.test(value) || CODE.test(value)) {
    return true;
  }

  const signature = value.split(".")[2];

  return looksLikeJwt(value) && signature !== undefined && OPAQUE.test(decodeSegment(signature));
};
