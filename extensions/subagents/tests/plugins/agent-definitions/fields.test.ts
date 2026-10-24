import { describe, expect, it } from "vitest";
import { FRONTMATTER_FIELDS } from "../../../core/agent-definitions/fields.ts";

describe("frontmatter fields", () => {
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
});
