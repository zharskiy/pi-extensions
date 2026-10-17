import { describe, expect, it } from "vitest";
import { parseDefinition } from "../../../src/plugins/agent-definitions/loader.ts";
import {
  type AgentTemplate,
  agentTemplate,
  DESCRIPTION_PLACEHOLDER,
} from "../../../src/plugins/agent-setup/agent-template.ts";

const parse = (template: AgentTemplate) => parseDefinition(agentTemplate(template), "x.md", "user");

describe("agent template", () => {
  it("writes a lead that loads with the lead defaults", () => {
    const { definition, errors, warnings } = parse({
      name: "docs-writer",
      description: "Use for writing docs.",
      kind: "lead",
      model: "provider/model-id:high",
    });

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(definition).toMatchObject({
      name: "docs-writer",
      description: "Use for writing docs.",
      model: "provider/model-id",
      thinking: "high",
      limit: 120_000,
      tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
      skills: [],
      subagents: ["scout"],
      worktree: false,
      mcp: true,
    });
    expect(definition?.prompt).toContain("Never hand your whole task to another agent.");
    expect(definition?.prompt).toContain("Sections:");
  });

  it("writes a read-only chore without subagents or MCP", () => {
    const { definition, errors } = parse({
      name: "lookup",
      description: "Use for lookups.",
      kind: "chore",
      model: "",
    });

    expect(errors).toEqual([]);
    expect(definition).toMatchObject({
      limit: 80_000,
      tools: ["read", "grep", "find", "ls"],
      subagents: [],
      mcp: false,
    });
    expect(definition?.model).toBeUndefined();
    expect(definition?.prompt).not.toContain("scout");
  });

  it("keeps the field comments out of the prompt and every field documented", () => {
    const text = agentTemplate({ name: "a", description: "d", kind: "lead", model: "" });
    const head = text.split("\n---\n")[0];
    const fields = ["name", "description", "model", "limit", "tools", "skills", "subagents", "worktree"];

    [...fields, "mcp"].forEach((field) => {
      expect(head).toContain(`# ${field}:`);
    });
    expect(text).toContain("model: inherit");
    expect(parseDefinition(text, "x.md", "user").definition?.prompt).not.toContain("#");
  });

  it("puts a placeholder in an empty description and quotes one YAML would misread", () => {
    const described = (description: string) =>
      parse({ name: "a", description, kind: "lead", model: "" }).definition?.description;

    expect(described("  ")).toBe(DESCRIPTION_PLACEHOLDER);
    expect(described("[x, y]")).toBe("[x, y]");
    expect(described("true")).toBe("true");
    expect(described("two\nlines")).toBe("two lines");
  });
});
