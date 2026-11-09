import { describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import {
  matchRules,
  rewriteRequestHeaders,
  ruleApplies,
  scrubResponseHeaders,
  withoutStrayPlaceholders,
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
  it("substitutes the placeholder in auth-like headers and strips it from any other header", () => {
    const headers = [
      ["Authorization", `Bearer ${PLACEHOLDER}`],
      ["x-api-key", PLACEHOLDER],
      ["proxy-authorization", PLACEHOLDER],
      ["Sec-WebSocket-Key", PLACEHOLDER],
      ["x-trace", PLACEHOLDER],
      ["accept", "*/*"],
    ] as const;

    expect(rewriteRequestHeaders([...headers], rule(), "secret").headers).toEqual([
      ["Authorization", "Bearer secret"],
      ["x-api-key", "secret"],
      ["accept", "*/*"],
    ]);
  });

  it("substitutes only in the header a header rule names", () => {
    const header = rule({ header: "x-api-key", template: "{secret}" });
    const headers = [
      ["x-api-key", PLACEHOLDER],
      ["Authorization", `Bearer ${PLACEHOLDER}`],
      ["x-echo-token", PLACEHOLDER],
    ] as const;

    expect(rewriteRequestHeaders([...headers], header, "secret").headers).toEqual([["x-api-key", "secret"]]);
  });

  it("strips a stray placeholder when the secret is unavailable", () => {
    const header = rule({ header: "x-api-key" });

    expect(rewriteRequestHeaders([["sec-websocket-key", PLACEHOLDER]], header, undefined).headers).toEqual(
      [],
    );
  });

  it("sets the header from the template when it is absent", () => {
    const git = rule({ placeholder: undefined, header: "authorization", template: "Basic {secret}" });

    expect(rewriteRequestHeaders([["accept", "*/*"]], git, "c2VjcmV0").headers).toEqual([
      ["accept", "*/*"],
      ["authorization", "Basic c2VjcmV0"],
    ]);
  });

  it("sets the template when the rule header still carries the placeholder", () => {
    const header = rule({ header: "x-goog-user-project", template: "{secret}" });

    expect(rewriteRequestHeaders([["x-goog-user-project", PLACEHOLDER]], header, "secret").headers).toEqual([
      ["x-goog-user-project", "secret"],
    ]);
  });

  it("leaves a header the client set to its own value", () => {
    const header = rule({ header: "x-api-key" });

    expect(rewriteRequestHeaders([["x-api-key", "mine"]], header, "secret").headers).toEqual([
      ["x-api-key", "mine"],
    ]);
  });

  it("strips the placeholder header when the secret is unavailable", () => {
    const headers = [
      ["authorization", `Bearer ${PLACEHOLDER}`],
      ["accept", "*/*"],
    ] as const;

    expect(rewriteRequestHeaders([...headers], rule({ header: "authorization" }), undefined).headers).toEqual(
      [["accept", "*/*"]],
    );
  });

  it("never substitutes into a header that is not a carrier", () => {
    expect(rewriteRequestHeaders([[":path", `/x?key=${PLACEHOLDER}`]], rule(), "secret").headers).toEqual([]);
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

describe("Basic credentials", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  it("substitutes the placeholder inside a Basic value and re-encodes it", () => {
    const sent = b64(`x-access-token:${PLACEHOLDER}`);
    const rewritten = rewriteRequestHeaders([["Authorization", `Basic ${sent}`]], rule(), "gho_real");

    expect(rewritten.headers).toEqual([["Authorization", `Basic ${b64("x-access-token:gho_real")}`]]);
    expect(rewritten.secrets).toEqual([{ value: b64("x-access-token:gho_real"), placeholder: sent }]);
  });

  it("decides and strips on the decoded view", () => {
    const encoded = `Basic ${b64(`me:${PLACEHOLDER}`)}`;
    const headers: Array<readonly [string, string]> = [
      ["authorization", encoded],
      ["x-trace", encoded],
      ["accept", "*/*"],
    ];

    expect(ruleApplies(headers, rule())).toBe(true);
    expect(withoutStrayPlaceholders(headers, rule())).toEqual([
      ["authorization", encoded],
      ["accept", "*/*"],
    ]);
    expect(ruleApplies([["authorization", `Basic ${b64("me:other")}`]], rule())).toBe(false);
    expect(rewriteRequestHeaders([["authorization", encoded]], rule(), undefined).headers).toEqual([]);
  });

  it("scrubs the exact base64 it sent from response headers", () => {
    const sent = b64(`me:${PLACEHOLDER}`);
    const rewritten = rewriteRequestHeaders([["authorization", `Basic ${sent}`]], rule(), "s3cret");
    const echoed = b64("me:s3cret");
    const scrubbed = scrubResponseHeaders(
      [
        ["x-echo", `Basic ${echoed}`],
        ["x-raw", "s3cret"],
      ],
      [{ value: "s3cret", placeholder: PLACEHOLDER }, ...rewritten.secrets],
    );

    expect(JSON.stringify(scrubbed)).not.toContain(echoed);
    expect(scrubbed).toEqual([
      ["x-echo", `Basic ${sent}`],
      ["x-raw", PLACEHOLDER],
    ]);
  });
});
