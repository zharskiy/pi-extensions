import { describe, expect, it } from "vitest";
import { FRONTMATTER_FIELDS } from "../../../src/plugins/agent-definitions/fields.ts";

describe("frontmatter fields", () => {
  it("gives every field either a required flag or a default", () => {
    FRONTMATTER_FIELDS.forEach((spec) => {
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
});
