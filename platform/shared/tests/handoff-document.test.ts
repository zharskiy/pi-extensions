import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handoffPath, validateHandoff } from "../handoff-document.ts";

const STATUSES = ["done", "partial", "blocked"];

const handoff = (sections: Record<string, string>) =>
  Object.entries(sections)
    .map(([title, body]) => `## ${title}\n${body}\n`)
    .join("\n");

const complete = {
  Status: "partial",
  Outcome: "- goal",
  Evidence: "- tests pass",
  Blocker: "none",
  Next: "- continue",
  "Files touched": "none",
};

describe("validateHandoff", () => {
  it("accepts the sections in order with a status from the given list", () => {
    expect(validateHandoff(handoff(complete), STATUSES)).toEqual({ ok: true, status: "partial" });
    expect(validateHandoff(handoff({ ...complete, Status: "**Done**" }), STATUSES)).toEqual({
      ok: true,
      status: "done",
    });
  });

  it("reports missing, empty and misordered sections", () => {
    const { Next: _next, ...withoutNext } = complete;

    expect(validateHandoff(handoff(withoutNext), STATUSES)).toEqual({
      ok: false,
      errors: ["missing sections: Next"],
    });
    expect(validateHandoff(handoff({ ...complete, Blocker: "" }), STATUSES)).toEqual({
      ok: false,
      errors: ["empty sections: Blocker"],
    });

    const { Status, ...rest } = complete;
    const result = validateHandoff(handoff({ ...rest, Status }), STATUSES);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors[0]).toContain("must appear in this order");
  });

  it("judges the status against the statuses it is given", () => {
    expect(validateHandoff(handoff({ ...complete, Status: "done" }), ["partial", "blocked"])).toEqual({
      ok: false,
      errors: ["Status must be one of partial, blocked"],
    });
  });
});

describe("handoffPath", () => {
  it("puts the main session and every agent under one root named after the session", () => {
    const root = join(tmpdir(), "pi-handoff", "s1");

    expect(handoffPath("s1", { main: true })).toBe(join(root, "main-handoff.md"));
    expect(handoffPath("s1", { agentId: "scout-1a2b3c4d5e6f" })).toBe(
      join(root, "scout-1a2b3c4d5e6f-handoff.md"),
    );
  });
});
