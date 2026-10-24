import { describe, expect, it } from "vitest";
import { parseSessionLines, replaySystemMessages } from "../runtime/session-file.ts";

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

describe("session file prompt record", () => {
  it("reads the provider payload of the last prompt record", () => {
    const payload = { model: "provider/model", system: "You are explorer.", tools: [{ name: "read" }] };
    const entry = (data: unknown) => JSON.stringify({ type: "custom", customType: RECORD, data });
    const record = parseSessionLines(
      [entry({ providerPayload: { stale: true } }), entry({ providerPayload: payload }), user],
      RECORD,
    );

    expect(record.providerPayload).toEqual(payload);
  });

  it("has no payload without a prompt record", () => {
    expect(parseSessionLines([user], RECORD).providerPayload).toBeUndefined();
  });
});

describe("system message replay", () => {
  it("applies added and removed sections and tools in order", () => {
    const messages = [
      {
        role: "system",
        sections: { preamble: "You are explorer.", cwd: "Current directory: /repo" },
        toolsAdded: [
          { name: "read", description: "Read a file.", parameters: {} },
          { name: "ls", description: "List a directory.", parameters: {} },
        ],
      },
      { role: "user", sections: { ignored: "x" } },
      { role: "system", sections: { cwd: null }, toolsRemoved: [{ name: "ls" }] },
    ];

    const replay = replaySystemMessages(messages);

    expect([...replay.sections]).toEqual([["preamble", "You are explorer."]]);
    expect([...replay.tools.values()]).toEqual([
      { name: "read", description: "Read a file.", parameters: {} },
    ]);
  });
});
