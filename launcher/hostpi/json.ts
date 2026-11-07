import type { JsonObject } from "./types.ts";

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const objectOr = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

const escapeToken = (token: string) => token.replaceAll("~", "~0").replaceAll("/", "~1");

export const jsonPointer = (tokens: Array<string | number>) =>
  tokens.map((token) => `/${escapeToken(String(token))}`).join("");
