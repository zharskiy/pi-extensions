import { describe, expect, it } from "vitest";
import { handoffPlugin } from "../../../src/plugins/handoff/index.ts";
import { validateHandoff } from "../../../src/plugins/handoff/schema.ts";
import { VALID_HANDOFF } from "../../helpers/handoff.ts";
import { createHarness } from "../../helpers/harness.ts";

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
    const harness = createHarness([handoffPlugin]);
    const text = harness.services.require("handoff").instruction("/tmp/x/handoff.md");

    expect(text).toContain("/tmp/x/handoff.md");
    expect(text).not.toContain("{{path}}");
  });
});
