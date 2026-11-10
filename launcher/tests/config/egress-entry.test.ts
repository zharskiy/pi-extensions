import { describe, expect, it } from "vitest";
import {
  authorityOf,
  fillTemplate,
  isLoopbackName,
  matchesDenyEntry,
  matchesPattern,
  normalizeHost,
  parseEntry,
} from "../../config/index.ts";

describe("normalizeHost", () => {
  it.each([
    [" API.Example.COM ", "api.example.com"],
    ["example.com.", "example.com"],
    ["plain", "plain"],
  ])("turns %j into %j", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
});

describe("parseEntry", () => {
  it.each([
    ["api.example.com", { pattern: "api.example.com", port: undefined }],
    ["API.example.com:8443", { pattern: "api.example.com", port: 8443 }],
    [" *.Example.com. ", { pattern: "*.example.com", port: undefined }],
    ["*.example.com:80", { pattern: "*.example.com", port: 80 }],
  ])("reads %j", (entry, expected) => {
    expect(parseEntry(entry)).toEqual(expected);
  });
});

describe("matchesPattern", () => {
  it.each([
    ["api.example.com", "api.example.com", true],
    ["api.example.com", "example.com", false],
    ["api.example.com", "*.example.com", true],
    ["a.b.example.com", "*.example.com", false],
    ["example.com", "*.example.com", false],
    ["evilexample.com", "*.example.com", false],
  ])("%s against %s is %s", (host, pattern, expected) => {
    expect(matchesPattern(host, pattern)).toBe(expected);
  });
});

describe("matchesDenyEntry", () => {
  it.each([
    ["paste.example.com", "paste.example.com", true],
    ["www.paste.example.com", "paste.example.com", true],
    ["a.b.paste.example.com", "paste.example.com", true],
    ["evilpaste.example.com", "paste.example.com", false],
    ["example.com", "paste.example.com", false],
    ["www.paste.example.com", "*.paste.example.com", true],
    ["a.b.paste.example.com", "*.paste.example.com", true],
    ["paste.example.com", "*.paste.example.com", false],
    ["evilpaste.example.com", "*.paste.example.com", false],
  ])("%s against %s is %s", (host, pattern, expected) => {
    expect(matchesDenyEntry(host, pattern)).toBe(expected);
  });
});

describe("authorityOf", () => {
  it("omits the TLS port and keeps any other", () => {
    expect(authorityOf("api.example.com", 443)).toBe("api.example.com");
    expect(authorityOf("api.example.com", 8443)).toBe("api.example.com:8443");
  });
});

describe("isLoopbackName", () => {
  it.each([
    ["localhost", true],
    ["db.localhost", true],
    ["notlocalhost", false],
    ["localhost.example.com", false],
  ])("%s is %s", (host, expected) => {
    expect(isLoopbackName(host)).toBe(expected);
  });
});

describe("fillTemplate", () => {
  it("puts the secret at every marker and defaults to the bare secret", () => {
    expect(fillTemplate("Bearer {secret}", "s3")).toBe("Bearer s3");
    expect(fillTemplate("{secret}:{secret}", "s3")).toBe("s3:s3");
    expect(fillTemplate(undefined, "s3")).toBe("s3");
  });
});
