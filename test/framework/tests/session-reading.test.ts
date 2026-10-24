import { describe, expect, it } from "vitest";
import { bashCommands, commandsLine, largestToolOutput } from "../index.ts";

describe("bashCommands", () => {
  it("lists the bash commands of assistant tool calls in order", () => {
    const items = [
      { kind: "user", text: "go" },
      {
        kind: "assistant",
        toolCalls: [
          { name: "bash", args: { command: "git diff --stat" } },
          { name: "read", args: { path: "a.ts" } },
        ],
      },
      { kind: "tool", text: "output" },
      { kind: "assistant", toolCalls: [{ name: "bash", args: { command: "npm test" } }] },
      { kind: "assistant", toolCalls: [{ name: "bash", args: {} }] },
    ];

    expect(bashCommands(items)).toEqual(["git diff --stat", "npm test"]);
  });
});

describe("commandsLine", () => {
  it("joins the commands on one indented line, each on one line", () => {
    expect(commandsLine(["git diff --stat", "npx vitest run\n  a.test.ts"])).toBe(
      "    bash 2: git diff --stat · npx vitest run a.test.ts",
    );
  });

  it("cuts each command to 80 characters and shows at most 8", () => {
    const line = commandsLine([
      `echo ${"y".repeat(100)}`,
      ...Array.from({ length: 9 }, (_, index) => `c${index}`),
    ]);

    expect(line).toBe(`    bash 10: echo ${"y".repeat(75)} · c0 · c1 · c2 · c3 · c4 · c5 · c6, …`);
  });

  it("shows a lead that ran no commands", () => {
    expect(commandsLine([])).toBe("    bash 0");
  });
});

describe("largestToolOutput", () => {
  it("returns the longest text of the named tool, 0 when there is none", () => {
    const items = [
      { toolName: "bash", text: "12345" },
      { toolName: "read", text: "1234567890" },
      { toolName: "bash", text: "12" },
    ];

    expect(largestToolOutput(items, "bash")).toBe(5);
    expect(largestToolOutput(items, "grep")).toBe(0);
  });
});
