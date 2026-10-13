import { describe, expect, it } from "vitest";
import { parseSessionLines } from "../../adapter/session-file.ts";

const usage = (input: number, output: number, cacheRead: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (value: ReturnType<typeof usage>, stopReason = "stop") =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason, usage: value },
  });

const user = JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });

describe("session file context", () => {
  it("measures the context at the last assistant usage, skipping aborted ones", () => {
    const record = parseSessionLines(
      [
        user,
        assistant(usage(100, 10, 0)),
        assistant(usage(300, 20, 1_000)),
        assistant(usage(5, 0, 0), "aborted"),
      ],
      "x:prompt-record",
    );

    expect(record.contextTokens).toBe(1_320);
  });

  it("has no measured context without assistant usage", () => {
    expect(parseSessionLines([user], "x:prompt-record").contextTokens).toBeUndefined();
  });
});

const RECORD = "x:prompt-record";

const system = (message: Record<string, unknown>) =>
  JSON.stringify({ type: "message", message: { role: "system", content: "", ...message } });

describe("session file prompt record", () => {
  it("replays prompt sections, tools, skills, guidelines, payload and model", () => {
    const payload = { model: "provider/model", system: "You are explorer.", tools: [{ name: "read" }] };
    const record = parseSessionLines(
      [
        system({
          sections: { preamble: "You are explorer.", cwd: "Current directory: /repo" },
          toolsAdded: [
            { name: "read", description: "Read a file.", parameters: {} },
            { name: "ls", description: "List a directory.", parameters: {} },
          ],
        }),
        system({ sections: { cwd: null }, toolsRemoved: [{ name: "ls" }] }),
        JSON.stringify({
          type: "custom",
          customType: RECORD,
          data: {
            agentId: "explorer-1",
            model: "provider/model",
            skills: [{ name: "search", description: "Search" }],
            guidelines: ["Use read."],
            providerPayload: payload,
          },
        }),
        user,
      ],
      RECORD,
    );

    expect(record.prompt.sections.map((section) => section.name)).toEqual(["preamble"]);
    expect(record.prompt.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(record.prompt.skills).toEqual([{ name: "search", description: "Search" }]);
    expect(record.prompt.guidelines).toEqual(["Use read."]);
    expect(record.prompt.providerPayload).toEqual(payload);
    expect(record.prompt.model).toBe("provider/model");
  });

  it("replays MCP tools and sections", () => {
    const record = parseSessionLines(
      [
        system({
          sections: { mcp_servers: "MCP servers reached through codemode:\n- mcp__docs (codemode)" },
          toolsAdded: [
            { name: "codemode", description: "Run a script.", parameters: {} },
            { name: "mcp__github__create_issue", description: "Create an issue.", parameters: {} },
          ],
        }),
      ],
      RECORD,
    );

    expect(record.prompt.sections).toEqual([
      { name: "mcp_servers", text: "MCP servers reached through codemode:\n- mcp__docs (codemode)" },
    ]);
    expect(record.prompt.tools.map((tool) => tool.name)).toEqual(["codemode", "mcp__github__create_issue"]);
    expect(record.prompt.providerPayload).toBeUndefined();
  });
});
