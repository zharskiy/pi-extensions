import { describe, expect, it } from "vitest";
import { HANDOFF_SECTIONS, handoffDocument } from "../valid-handoff.ts";

describe("valid handoff", () => {
  it("keeps the shared section set immutable", () => {
    expect(Object.isFrozen(HANDOFF_SECTIONS)).toBe(true);
    expect(() => {
      Object.assign(HANDOFF_SECTIONS, { Status: "done" });
    }).toThrow(TypeError);
    expect(handoffDocument(HANDOFF_SECTIONS)).toContain("## Status\npartial\n");
  });
});
