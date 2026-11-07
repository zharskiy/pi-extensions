import { describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import {
  matchRules,
  rewriteRequestHeaders,
  scrubResponseHeaders,
  transformSecret,
} from "../../proxy/rules.ts";

const PLACEHOLDER = "pi-sandbox-0123456789abcdef01234567";

const rule = (overrides: Partial<CredentialRule> = {}): CredentialRule => ({
  id: "api",
  host: "api.test",
  placeholder: PLACEHOLDER,
  secret: { env: "API" },
  ...overrides,
});

describe("matchRules", () => {
  const rules = [
    rule({ id: "root" }),
    rule({ id: "mcp", pathPrefix: "/mcp" }),
    rule({ id: "alt", port: 8443 }),
    rule({ id: "other", host: "other.test" }),
  ];

  it("matches host and port, most specific path first", () => {
    expect(matchRules(rules, "API.test", 443, "/mcp/tools?x=1").map((entry) => entry.id)).toEqual([
      "mcp",
      "root",
    ]);
  });

  it("keeps a path prefix to whole segments", () => {
    expect(matchRules(rules, "api.test", 443, "/mcpx").map((entry) => entry.id)).toEqual(["root"]);
  });

  it("matches a rule port only on that port", () => {
    expect(matchRules(rules, "api.test", 8443, "/").map((entry) => entry.id)).toEqual(["alt"]);
  });
});

describe("rewriteRequestHeaders", () => {
  it("substitutes the placeholder in auth-like headers only", () => {
    const headers = [
      ["Authorization", `Bearer ${PLACEHOLDER}`],
      ["x-api-key", PLACEHOLDER],
      ["proxy-authorization", PLACEHOLDER],
      ["x-trace", PLACEHOLDER],
    ] as const;

    expect(rewriteRequestHeaders([...headers], rule(), "secret")).toEqual([
      ["Authorization", "Bearer secret"],
      ["x-api-key", "secret"],
      ["proxy-authorization", PLACEHOLDER],
      ["x-trace", PLACEHOLDER],
    ]);
  });

  it("sets the header from the template when it is absent", () => {
    const git = rule({ placeholder: undefined, header: "authorization", template: "Basic {secret}" });

    expect(rewriteRequestHeaders([["accept", "*/*"]], git, "c2VjcmV0")).toEqual([
      ["accept", "*/*"],
      ["authorization", "Basic c2VjcmV0"],
    ]);
  });

  it("sets the template when the rule header still carries the placeholder", () => {
    const header = rule({ header: "x-goog-user-project", template: "{secret}" });

    expect(rewriteRequestHeaders([["x-goog-user-project", PLACEHOLDER]], header, "secret")).toEqual([
      ["x-goog-user-project", "secret"],
    ]);
  });

  it("leaves a header the client set to its own value", () => {
    const header = rule({ header: "x-api-key" });

    expect(rewriteRequestHeaders([["x-api-key", "mine"]], header, "secret")).toEqual([["x-api-key", "mine"]]);
  });

  it("strips the placeholder header when the secret is unavailable", () => {
    const headers = [
      ["authorization", `Bearer ${PLACEHOLDER}`],
      ["accept", "*/*"],
    ] as const;

    expect(rewriteRequestHeaders([...headers], rule({ header: "authorization" }), undefined)).toEqual([
      ["accept", "*/*"],
    ]);
  });

  it("never touches the query string", () => {
    expect(rewriteRequestHeaders([[":path", `/x?key=${PLACEHOLDER}`]], rule(), "secret")).toEqual([
      [":path", `/x?key=${PLACEHOLDER}`],
    ]);
  });
});

describe("scrubResponseHeaders", () => {
  it("replaces the secret by its placeholder in every header value", () => {
    const scrubbed = scrubResponseHeaders(
      [
        ["Location", "https://api.test/cb?code=1&token=secret-value"],
        ["Set-Cookie", "session=secret-value; Secure"],
        ["WWW-Authenticate", 'Bearer realm="secret-value"'],
        ["x-other", "plain"],
      ],
      [{ value: "secret-value", placeholder: PLACEHOLDER }],
    );

    expect(scrubbed).toEqual([
      ["Location", `https://api.test/cb?code=1&token=${PLACEHOLDER}`],
      ["Set-Cookie", `session=${PLACEHOLDER}; Secure`],
      ["WWW-Authenticate", `Bearer realm="${PLACEHOLDER}"`],
      ["x-other", "plain"],
    ]);
  });

  it("redacts a secret of a rule without a placeholder", () => {
    expect(scrubResponseHeaders([["x-echo", "abc-token"]], [{ value: "abc-token" }])).toEqual([
      ["x-echo", "pi-sandbox-redacted"],
    ]);
  });
});

describe("transformSecret", () => {
  it("turns a URL secret into base64 of its decoded userinfo", () => {
    const urlRule = rule({ transform: "urlUserinfoBase64" });

    expect(transformSecret(urlRule, "https://me%40corp:pa%3Ass@registry.test/")).toBe(
      Buffer.from("me@corp:pa:ss").toString("base64"),
    );
    expect(transformSecret(urlRule, "not a url")).toBeUndefined();
    expect(transformSecret(rule(), "plain")).toBe("plain");
  });
});
