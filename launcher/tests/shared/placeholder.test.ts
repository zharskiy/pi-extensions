import { describe, expect, it } from "vitest";
import { isPlaceholder, jwtShapedPlaceholder, placeholderFor, sha256Hex } from "../../shared/index.ts";
import { looksLikeJwt } from "../../shared/placeholder.ts";

const SALT = "a".repeat(64);

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

const JWT = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ sub: "user", exp: 1 })}.real-signature_part`;

describe("placeholderFor", () => {
  it("is pi-sandbox- plus 24 hex characters of sha256(salt + identity)", () => {
    const value = placeholderFor(SALT, "auth:corp:key");

    expect(value).toBe(`pi-sandbox-${sha256Hex(`${SALT}auth:corp:key`).slice(0, 24)}`);
    expect(value).toMatch(/^pi-sandbox-[0-9a-f]{24}$/);
  });

  it("is stable for one salt and identity and differs otherwise", () => {
    expect(placeholderFor(SALT, "x")).toBe(placeholderFor(SALT, "x"));
    expect(placeholderFor(SALT, "x")).not.toBe(placeholderFor(SALT, "y"));
    expect(placeholderFor(SALT, "x")).not.toBe(placeholderFor("b".repeat(64), "x"));
  });
});

describe("looksLikeJwt", () => {
  it("accepts three base64url segments whose first two are JSON objects", () => {
    expect(looksLikeJwt(JWT)).toBe(true);
  });

  it("refuses opaque tokens and dotted strings that are not JSON", () => {
    expect(looksLikeJwt("sk-opaque-token")).toBe(false);
    expect(looksLikeJwt("a.b.c")).toBe(false);
    expect(looksLikeJwt(`${segment({ alg: "none" })}.${segment([1])}.x`)).toBe(false);
  });
});

describe("jwtShapedPlaceholder", () => {
  const decoded = (part: string | undefined) =>
    JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));

  it("has its own header, keeps the lasting claims and replaces the signature", () => {
    const value = jwtShapedPlaceholder(JWT, SALT, "auth:corp:access");
    const [header, payload, signature] = value.split(".");

    expect(decoded(header)).toEqual({ alg: "none", typ: "JWT" });
    expect(decoded(payload)).toEqual({ sub: "user" });
    expect(signature).not.toContain("real-signature");
    expect(Buffer.from(signature ?? "", "base64url").toString("utf8")).toBe(
      placeholderFor(SALT, "auth:corp:access"),
    );
    expect(looksLikeJwt(value)).toBe(true);
  });

  it("stays the same when the host token is refreshed or signed with another key", () => {
    const refreshed = `${segment({ alg: "RS256", kid: "new" })}.${segment({
      sub: "user",
      exp: 2,
      iat: 1,
      nbf: 1,
      jti: "other",
      auth_time: 1,
    })}.another-signature`;

    expect(jwtShapedPlaceholder(refreshed, SALT, "auth:corp:access")).toBe(
      jwtShapedPlaceholder(JWT, SALT, "auth:corp:access"),
    );
  });

  it("falls back to the opaque placeholder for a token that is not a JWT", () => {
    expect(jwtShapedPlaceholder("opaque", SALT, "auth:corp:access")).toBe(
      placeholderFor(SALT, "auth:corp:access"),
    );
  });
});

describe("isPlaceholder", () => {
  it("recognises opaque and JWT-shaped placeholders", () => {
    expect(isPlaceholder(placeholderFor(SALT, "x"))).toBe(true);
    expect(isPlaceholder(jwtShapedPlaceholder(JWT, SALT, "x"))).toBe(true);
  });

  it("refuses real-looking values", () => {
    expect(isPlaceholder(JWT)).toBe(false);
    expect(isPlaceholder("sk-live-1234")).toBe(false);
    expect(isPlaceholder("pi-sandbox-short")).toBe(false);
  });
});
