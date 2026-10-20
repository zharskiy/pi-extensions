import { describe, expect, it } from "vitest";
import { planImport } from "../src/plan.ts";

const context = { home: "/home/me", sep: "/" };

const target = (text?: string) => ({ label: "mcp.json", text });

describe("import plan", () => {
  it("adds converted servers and keeps the rest of the file", () => {
    const plan = planImport(
      "claude",
      [{ label: ".mcp.json", servers: { docs: { type: "http", url: "https://x.test/mcp" } } }],
      target('{\n    "autoEnableCodemode": false,\n    "mcpServers": { "old": { "command": "old" } }\n}\n'),
      context,
    );

    expect(plan.added.map((entry) => entry.name)).toEqual(["docs"]);
    expect(JSON.parse(plan.text ?? "")).toEqual({
      autoEnableCodemode: false,
      mcpServers: { old: { command: "old" }, docs: { type: "http", url: "https://x.test/mcp" } },
    });
    expect(plan.text).toMatch(/^\{\n {4}"autoEnableCodemode"/);
  });

  it("creates the file content when there is none", () => {
    const plan = planImport(
      "cursor",
      [{ label: "a", servers: { one: { command: "x" } } }],
      target(),
      context,
    );

    expect(plan.text).toBe('{\n  "mcpServers": {\n    "one": {\n      "command": "x"\n    }\n  }\n}\n');
  });

  it("never overwrites an existing server, also when names differ only in - and _", () => {
    const plan = planImport(
      "claude",
      [{ label: "a", servers: { same: { command: "new" }, "my-tool": { command: "new" } } }],
      target('{"mcpServers":{"same":{"command":"old"},"my_tool":{"command":"old"}}}'),
      context,
    );

    expect(plan.added).toEqual([]);
    expect(plan.text).toBeUndefined();
    expect(plan.skipped).toEqual([
      { name: "same", origin: "a", reason: "already in mcp.json, left unchanged", present: true },
      {
        name: "my-tool",
        origin: "a",
        reason: 'pi treats it as the same server as "my_tool" in mcp.json, left unchanged',
        present: true,
      },
    ]);
  });

  it("lets the first source win for a name defined twice", () => {
    const plan = planImport(
      "claude",
      [
        { label: "local", servers: { x: { command: "local" } } },
        { label: "project", servers: { x: { command: "project" } } },
      ],
      target(),
      context,
    );

    expect(plan.added).toMatchObject([{ name: "x", origin: "local", server: { command: "local" } }]);
    expect(plan.skipped).toEqual([
      { name: "x", origin: "project", reason: "also defined in local, which wins" },
    ]);
  });

  it("skips invalid names and unsupported entries", () => {
    const plan = planImport(
      "claude",
      [
        {
          label: "a",
          servers: { "bad name": { command: "x" }, old: { type: "sse", url: "https://x.test/sse" } },
        },
      ],
      target(),
      context,
    );

    expect(plan.added).toEqual([]);
    expect(plan.skipped.map((skip) => skip.name)).toEqual(["bad name", "old"]);
  });

  it("refuses a target file that is not a valid mcp.json", () => {
    expect(planImport("claude", [], target("{"), context).error).toMatch(/^mcp\.json: /);
    expect(planImport("claude", [], target('{"mcpServers":[]}'), context).error).toMatch(
      /"mcpServers" object/,
    );
  });
});
