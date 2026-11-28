import { describe, expect, it } from "vitest";
import { convertServer, needsSignIn } from "../core/convert.ts";

const context = { home: "/home/me", sep: "/" };

const claude = (raw: unknown) => convertServer("claude", raw, context);

const cursor = (raw: unknown) => convertServer("cursor", raw, context);

const codex = (raw: unknown) => convertServer("codex", raw, context);

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

describe("Codex entries", () => {
  it("copies a stdio entry", () => {
    expect(codex({ command: "npx", args: ["-y", "srv"], cwd: "/work", env: { A: "b" } })).toEqual({
      server: { command: "npx", args: ["-y", "srv"], cwd: "/work", env: { A: "b" } },
      notes: [],
    });
  });

  it("builds the headers from http_headers, env_http_headers and bearer_token_env_var, later ones winning", () => {
    const result = codex({
      url: "https://x.test/mcp",
      http_headers: { "X-Client": "pinata", Authorization: "Basic x" },
      env_http_headers: { "X-Api-Key": "API_KEY", "X-Client": "CLIENT" },
      bearer_token_env_var: "TOKEN",
    });

    expect(result).toEqual({
      server: {
        url: "https://x.test/mcp",
        headers: { "X-Client": "${CLIENT}", Authorization: "Bearer ${TOKEN}", "X-Api-Key": "${API_KEY}" },
      },
      notes: [
        "env_http_headers became ${VAR} headers; pi fails to connect while a variable is unset, Codex left the header out",
      ],
    });
  });

  it("keeps literal $ and a leading ! in env and header values", () => {
    expect(codex({ command: "srv", env: { PASS: "!a$b", PATHS: "${X}" } })).toEqual({
      server: { command: "srv", env: { PASS: "$!a$$b", PATHS: "$${X}" } },
      notes: [
        'env.PASS contains "$", which pi would read as a variable; written as "$$" to keep it literal',
        'env.PATHS contains "$", which pi would read as a variable; written as "$$" to keep it literal',
        'env.PASS starts with "!", which pi would run as a command; written as "$!..." to keep it literal',
      ],
    });
    expect(codex({ url: "https://x.test/mcp", http_headers: { X: "a$b" } })).toMatchObject({
      server: { headers: { X: "a$$b" } },
    });
    expect(codex({ command: "$srv", args: ["$A"] })).toEqual({
      server: { command: "$srv", args: ["$A"] },
      notes: [],
    });
    expect(codex({ url: "https://x.test/$mcp" })).toEqual({
      server: { url: "https://x.test/$mcp" },
      notes: [],
    });
  });

  it("copies enabled = false and the tool timeout in whole seconds", () => {
    expect(codex({ command: "srv", enabled: false, tool_timeout_sec: 90.5 })).toEqual({
      server: { command: "srv", enabled: false, timeout: 91 },
      notes: [],
    });
    expect(codex({ command: "srv", enabled: true })).toEqual({ server: { command: "srv" }, notes: [] });
  });

  it("hides every tool but enabled_tools, then hides disabled_tools", () => {
    expect(codex({ command: "srv", enabled_tools: ["a", "b"], disabled_tools: ["b"] })).toMatchObject({
      server: { toolExposure: { "*": "hidden", a: "codemode", b: "hidden" } },
    });
    expect(codex({ command: "srv", disabled_tools: ["c"] })).toMatchObject({
      server: { toolExposure: { c: "hidden" } },
    });
  });

  it("keeps the OAuth client id, callback port and scopes and drops the other OAuth keys", () => {
    const result = codex({
      url: "https://x.test/mcp",
      scopes: ["read", "write"],
      oauth: { client_id: "id", callback_port: 8765, client_secret: "s" },
    });

    expect(result).toEqual({
      server: {
        url: "https://x.test/mcp",
        oauth: { clientId: "id", callbackPort: 8765, scope: "read write" },
      },
      notes: ["dropped oauth client_secret: pi has no such field"],
    });
  });

  it("drops env_vars with a note", () => {
    expect(codex({ command: "srv", env_vars: ["API_KEY"] })).toEqual({
      server: { command: "srv" },
      notes: ["dropped env_vars: pi passes its whole environment to stdio servers"],
    });
  });

  it("reads an entry with both command and url as stdio and drops the url", () => {
    expect(codex({ command: "srv", url: "https://x.test/mcp" })).toEqual({
      server: { command: "srv" },
      notes: ["dropped url: pi has no such field"],
    });
  });

  it("skips an entry without command or url and one with malformed fields", () => {
    expect(codex({ enabled: true })).toEqual({ skip: expect.stringMatching(/needs "command"/) });
    expect(codex({ command: "x", args: [1] })).toEqual({ skip: "has args that are not a list of strings" });
  });

  it("drops every other field, type included, with a note", () => {
    expect(
      codex({ type: "sse", url: "https://x.test/mcp", http_headers_helper: "h", startup_timeout_sec: 5 }),
    ).toEqual({
      server: { url: "https://x.test/mcp" },
      notes: ["dropped type, http_headers_helper, startup_timeout_sec: pi has no such field"],
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
