import { parseJsonObject } from "../../shared/index.ts";
import { basicAuthorization } from "../parent.ts";
import type { HeaderPair } from "../rules.ts";

export interface TokenResponse {
  status: number;
  headers: HeaderPair[];
  body: Buffer;
}

const FORM_TYPE = "application/x-www-form-urlencoded";

const JSON_TYPE = "application/json";

const JSON_HEADERS: HeaderPair[] = [
  ["content-type", JSON_TYPE],
  ["cache-control", "no-store"],
];

const BASIC = /^Basic\s+([A-Za-z0-9+/=]+)$/i;

export const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

const mediaTypeOf = (contentType: string) => (contentType.split(";")[0] ?? "").trim().toLowerCase();

export const headerValue = (headers: HeaderPair[], name: string) =>
  headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? "";

export const sameUrl = (left: string, right: string) => {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
};

export const isFormType = (contentType: string) => mediaTypeOf(contentType) === FORM_TYPE;

export const isJsonType = (contentType: string) => mediaTypeOf(contentType) === JSON_TYPE;

export const isSuccess = (status: number) => status >= 200 && status < 300;

export const json = (status: number, body: object): TokenResponse => ({
  status,
  headers: JSON_HEADERS,
  body: Buffer.from(JSON.stringify(body)),
});

export const oauthError = (status: number, error: string, description: string) =>
  json(status, { error, error_description: `pi-sandbox: ${description}` });

export const parseJson = (body: Buffer) => parseJsonObject(body.toString("utf8"));

export const parseLoose = (body: Buffer) =>
  parseJson(body) ?? Object.fromEntries(new URLSearchParams(body.toString("utf8")));

export const basicCredentials = (headers: HeaderPair[]) => {
  const match = BASIC.exec(headerValue(headers, "authorization").trim());
  const decoded = match === null ? undefined : Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const separator = decoded?.indexOf(":") ?? -1;

  return decoded === undefined || separator === -1
    ? undefined
    : { user: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
};

export const swapBasic = (headers: HeaderPair[], placeholder: string, secret: string | undefined) =>
  headers.map(([name, value]): HeaderPair => {
    const credentials =
      name.toLowerCase() === "authorization" ? basicCredentials([[name, value]]) : undefined;

    if (credentials === undefined || credentials.secret !== placeholder || secret === undefined) {
      return [name, value];
    }

    return [name, basicAuthorization(`${credentials.user}:${secret}`)];
  });

export const authMethodOf = (headers: HeaderPair[], params: URLSearchParams) => {
  if (basicCredentials(headers) !== undefined) {
    return "client_secret_basic";
  }

  return params.has("client_secret") ? "client_secret_post" : "none";
};
