import { describe, expect, it } from "vitest";
import { FRONTMATTER_FIELDS, missingFieldMessage } from "../../src/model/frontmatter.ts";

describe("frontmatter schema", () => {
  it("gives every field a one-line meaning and either a required flag or a default", () => {
    FRONTMATTER_FIELDS.forEach((spec) => {
      expect(spec.meaning).toMatch(/^[^\n]+\.$/);
      expect(spec.required).toBe(spec.byDefault === undefined);
    });
  });

  it("lets only the list fields take all, each saying what all and its names mean", () => {
    const lists = FRONTMATTER_FIELDS.filter((spec) => spec.allMeaning !== undefined);

    expect(lists.map((spec) => spec.key)).toEqual(["tools", "skills", "subagents"]);

    FRONTMATTER_FIELDS.forEach((spec) => {
      expect(spec.kind === "list").toBe(spec.allMeaning !== undefined);
      expect(spec.kind === "list").toBe(spec.namesMeaning !== undefined);
    });
  });

  it("gives integers a minimum", () => {
    FRONTMATTER_FIELDS.filter((spec) => spec.kind === "integer").forEach((spec) => {
      expect(spec.min).toBeGreaterThanOrEqual(1);
    });
  });

  it("holds exactly the per-agent decisions", () => {
    expect(FRONTMATTER_FIELDS.map((spec) => spec.key)).toEqual([
      "name",
      "description",
      "model",
      "limit",
      "tools",
      "skills",
      "subagents",
      "worktree",
    ]);
  });

  it("names what a missing required field takes", () => {
    const messages = FRONTMATTER_FIELDS.filter((spec) => spec.required).map(missingFieldMessage);

    expect(messages).toEqual([
      "name is required",
      "description is required",
      "limit is required (context limit in tokens, for example limit: 100000)",
      "tools is required (tool names, all for the tools active in the main session, or [] for none)",
      "skills is required (skill names, all for every skill of the main session, or [] for none)",
      "subagents is required (agent names it may start, all for every other agent, or [] for none)",
    ]);
  });
});
