import { describe, expect, it } from "vitest";
import { parseAuthority, parseRequestTarget } from "../../proxy/request-target.ts";

const parse = (target: string) => parseRequestTarget(target, "api.test", 443);

describe("parseAuthority", () => {
  it("reads the host and the written port, port 80 included", () => {
    expect(parseAuthority("API.test:443")).toEqual({ host: "api.test", port: 443 });
    expect(parseAuthority("api.test:80")).toEqual({ host: "api.test", port: 80 });
    expect(parseAuthority("[::1]:80")).toEqual({ host: "[::1]", port: 80 });
  });

  it("uses the default port only when none is written", () => {
    expect(parseAuthority("api.test")).toBeUndefined();
    expect(parseAuthority("api.test", 443)).toEqual({ host: "api.test", port: 443 });
    expect(parseAuthority("api.test:8443", 443)).toEqual({ host: "api.test", port: 8443 });
  });

  it("refuses userinfo, paths, queries and fragments", () => {
    [
      "u@api.test:443",
      "u:p@api.test:443",
      ":p@api.test:443",
      "@api.test:443",
      "api.test:443/x",
      "api.test:443?q",
      "api.test:443#f",
      "",
    ].forEach((authority) => {
      expect(parseAuthority(authority, 443)).toBeUndefined();
    });
  });
});

describe("parseRequestTarget", () => {
  it("keeps an origin-form path and decodes it for rule matching", () => {
    expect(parse("/v1/team%20a/x?q=%2e%2e")).toEqual({
      ok: true,
      path: "/v1/team%20a/x?q=%2e%2e",
      decodedPath: "/v1/team a/x",
    });
  });

  it("rewrites an absolute-form target with the terminated authority to origin form", () => {
    expect(parse("https://API.test./v1/x?y=1")).toMatchObject({ ok: true, path: "/v1/x?y=1" });
    expect(parse("https://api.test:443")).toMatchObject({ ok: true, path: "/" });
    expect(parseRequestTarget("https://api.test:8443/x", "api.test", 8443)).toMatchObject({
      ok: true,
      path: "/x",
    });
  });

  it("refuses an absolute-form target naming another origin", () => {
    [
      "https://attacker.example/x",
      "https://api.test:8443/x",
      "http://api.test/x",
      "https://u@api.test/x",
      "*",
    ].forEach((target) => {
      expect(parse(target)).toMatchObject({ ok: false });
    });
  });

  it("refuses dot segments raw, percent-encoded in any case, or behind an encoded slash", () => {
    [
      "/v1/team-a/../team-b/x",
      "/v1/./x",
      "/v1/team-a/%2e%2e/team-b",
      "/v1/team-a/%2E%2e/team-b",
      "/v1/team-a/.%2E/team-b",
      "/v1/team-a%2f..%2fteam-b",
      "/v1/team-a\\..\\team-b",
      "/..",
      "https://api.test/v1/%2e%2e/x",
    ].forEach((target) => {
      expect(parse(target)).toMatchObject({ ok: false, reason: expect.stringContaining("dot segment") });
    });
  });

  it("keeps names that only look like dot segments", () => {
    expect(parse("/v1/...x/.well-known/a..b")).toMatchObject({ ok: true });
  });

  it("refuses malformed percent-encoding", () => {
    expect(parse("/v1/%zz")).toMatchObject({ ok: false });
  });
});
