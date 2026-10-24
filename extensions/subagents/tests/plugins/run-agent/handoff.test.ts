import { describe, expect, it } from "vitest";
import { VALID_HANDOFF } from "../../../../../test-framework/index.ts";
import { createHandoff } from "../../../src/plugins/run-agent/handoff.ts";
import { PACKAGE_ROOT } from "../../support/subagents-harness.ts";

const { instruction, validate: validateHandoff } = createHandoff(PACKAGE_ROOT);

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

  it("fills the handoff instruction with the target path", () => {
    const text = instruction("/tmp/x/handoff.md");

    expect(text).toContain("/tmp/x/handoff.md");
    expect(text).not.toContain("{{path}}");
    expect(text).toContain("Call the `handoff` tool");
  });
});
