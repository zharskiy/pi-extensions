import { describe, expect, it } from "vitest";
import { convertServer, needsSignIn } from "../core/convert.ts";

const context = { home: "/home/me", sep: "/" };

const claude = (raw: unknown) => convertServer("claude", raw, context);

const cursor = (raw: unknown) => convertServer("cursor", raw, context);

describe("Claude Code entries", () => {
  it("copies a stdio entry unchanged", () => {
    expect(claude({ type: "stdio", command: "npx", args: ["-y", "srv"], env: { A: "${A}" } })).toEqual({
      server: { type: "stdio", command: "npx", args: ["-y", "srv"], env: { A: "${A}" } },
      notes: [],
    });
  });

  it("copies an http entry with headers", () => {
    expect(
      claude({ type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer ${T}" } }),
    ).toEqual({
      server: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer ${T}" } },
      notes: [],
    });
  });

  it("skips sse and ws entries", () => {
    expect(claude({ type: "sse", url: "https://x.test/sse" })).toEqual({
      skip: expect.stringMatching(/legacy SSE/),
    });
    expect(claude({ type: "ws", url: "wss://x.test" })).toEqual({ skip: expect.stringMatching(/WebSocket/) });
    expect(claude({ type: "other", command: "x" })).toEqual({ skip: expect.stringMatching(/"other"/) });
  });

  it("skips entries without command or url, or with malformed fields", () => {
    expect(claude({})).toEqual({ skip: expect.stringMatching(/needs "command"/) });
    expect(claude({ command: "x", args: [1] })).toEqual({ skip: expect.stringMatching(/args/) });
    expect(claude("x")).toEqual({ skip: "is not an object" });
  });

  it("drops a default from ${VAR:-default} with a note", () => {
    const result = claude({ url: "https://x.test/mcp", headers: { Authorization: "Bearer ${TOKEN:-none}" } });

    expect(result).toEqual({
      server: { url: "https://x.test/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      notes: ["headers.Authorization: ${TOKEN:-none} became ${TOKEN}; pi has no defaults, so set TOKEN"],
    });
  });

  it("warns that pi does not expand variables outside env and headers", () => {
    const result = claude({ command: "srv", args: ["--root", "${ROOT}"] });

    expect(result).toMatchObject({ notes: [expect.stringMatching(/only in env and headers; args keep/)] });
  });

  it("converts the timeout from milliseconds to whole seconds", () => {
    expect(claude({ command: "srv", timeout: 30_500 })).toEqual({
      server: { command: "srv", timeout: 31 },
      notes: ["timeout 30500 ms became 31 s"],
    });
  });

  it("maps headersHelper to an Authorization !command", () => {
    const result = claude({ type: "http", url: "https://x.test/mcp", headersHelper: "get-headers.sh" });

    expect(result).toMatchObject({
      server: { headers: { Authorization: expect.stringMatching(/^!\(get-headers\.sh\) \| node -e /) } },
      notes: [expect.stringMatching(/^headersHelper became an Authorization header/)],
    });
  });

  it("keeps the oauth fields pi knows and drops the rest", () => {
    const result = claude({
      url: "https://x.test/mcp",
      oauth: { clientId: "id", callbackPort: 8080, other: 1 },
    });

    expect(result).toEqual({
      server: { url: "https://x.test/mcp", oauth: { clientId: "id", callbackPort: 8080 } },
      notes: ["dropped oauth other: pi has no such field"],
    });
  });

  it("keeps a literal leading ! from running as a command", () => {
    expect(claude({ command: "srv", env: { PASS: "!secret" } })).toMatchObject({
      server: { env: { PASS: "$!secret" } },
    });
  });

  it("drops unknown fields with a note", () => {
    expect(claude({ command: "srv", alwaysAllow: [] })).toEqual({
      server: { command: "srv" },
      notes: ["dropped alwaysAllow: pi has no such field"],
    });
  });
});

describe("Cursor entries", () => {
  it("rewrites ${env:X} to ${X}", () => {
    expect(cursor({ url: "https://x.test/mcp", headers: { Authorization: "Bearer ${env:TOKEN}" } })).toEqual({
      server: { url: "https://x.test/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      notes: ["headers.Authorization: ${env:TOKEN} became ${TOKEN}"],
    });
  });

  it("rewrites ${userHome} to ~ at the start of a path and to the home directory elsewhere", () => {
    const result = cursor({ command: "${userHome}/bin/srv", env: { DATA: "${userHome}/data" } });

    expect(result).toMatchObject({ server: { command: "~/bin/srv", env: { DATA: "/home/me/data" } } });
  });

  it("skips entries that use ${workspaceFolder}", () => {
    expect(cursor({ command: "srv", args: ["${workspaceFolder}"] })).toEqual({
      skip: expect.stringMatching(/workspaceFolder\} in args/),
    });
  });

  it("drops envFile and auth with notes", () => {
    expect(cursor({ url: "https://x.test/mcp", envFile: ".env", auth: { CLIENT_ID: "x" } })).toEqual({
      server: { url: "https://x.test/mcp" },
      notes: [
        "dropped envFile: pi does not read env files; put the variables in env or in your shell",
        "dropped auth (OAuth client settings): sign in with /mcp",
      ],
    });
  });

  it("does not apply Claude's default syntax rule", () => {
    expect(cursor({ command: "srv", env: { A: "${A:-b}" } })).toMatchObject({
      server: { env: { A: "${A:-b}" } },
    });
  });
});

describe("sign-in hint", () => {
  it("flags HTTP servers without an Authorization header", () => {
    expect(needsSignIn({ url: "https://x.test/mcp" })).toBe(true);
    expect(needsSignIn({ url: "https://x.test/mcp", headers: { authorization: "x" } })).toBe(false);
    expect(needsSignIn({ command: "srv" })).toBe(false);
  });
});
