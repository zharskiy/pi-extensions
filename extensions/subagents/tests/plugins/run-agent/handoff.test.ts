import { describe, expect, it } from "vitest";
import { VALID_HANDOFF } from "../../../../../test/framework/index.ts";
import { handoffService } from "../../../core/model/handoff.ts";

const { validate: validateHandoff, instruction, preface } = handoffService;

describe("handoff schema", () => {
  it("accepts the documented schema", () => {
    expect(validateHandoff(VALID_HANDOFF)).toEqual({ ok: true, status: "partial" });
  });

  it("rejects missing, empty, out-of-order sections and unknown status values", () => {
    const missing = validateHandoff("## Status\npartial\n## Outcome\nx");
    const reordered = validateHandoff(
      VALID_HANDOFF.replace("## Outcome", "## Tmp")
        .replace("## Blocker", "## Outcome")
        .replace("## Tmp", "## Blocker"),
    );
    const empty = validateHandoff(VALID_HANDOFF.replace("- trace token refresh", ""));
    const badStatus = validateHandoff(VALID_HANDOFF.replace("partial", "almost"));

    expect(missing).toEqual({
      ok: false,
      errors: ["missing sections: Evidence, Blocker, Next, Files touched"],
    });
    expect(reordered.ok).toBe(false);
    expect(empty).toEqual({ ok: false, errors: ["empty sections: Next"] });
    expect(badStatus).toEqual({ ok: false, errors: ["Status must be one of partial, blocked"] });
  });

  it("rejects a done status because a finished agent never writes a handoff", () => {
    expect(validateHandoff(VALID_HANDOFF.replace("partial", "done"))).toEqual({
      ok: false,
      errors: ["Status must be one of partial, blocked"],
    });
    expect(validateHandoff(VALID_HANDOFF.replace("partial", "blocked"))).toEqual({
      ok: true,
      status: "blocked",
    });
  });
});

describe("agent handoff instruction", () => {
  const text = instruction("/tmp/a3-handoff.md");

  it("starts from the context limit and offers only partial or blocked", () => {
    expect(text.startsWith("You have reached your context limit.")).toBe(true);
    expect(text).toContain("One word: partial or blocked.");
    expect(text).not.toContain("done");
    expect(text).not.toContain("Skills:");
    expect(text).toContain("the handoff waits for them");
    expect(text).toContain("attached to your successor's task");
  });
});

describe("agent successor preface", () => {
  it("names the agent, the link and the saved path", () => {
    const text = preface({ id: "a3", link: 2, path: "/tmp/a3-handoff.md" });

    expect(text).toContain("agent a3 as link 2");
    expect(text).toContain("/tmp/a3-handoff.md");
    expect(text).toContain("Next section");
  });
});
