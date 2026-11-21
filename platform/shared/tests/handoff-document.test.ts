import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HANDOFF_SECTIONS, handoffDocument } from "../../../test/framework/index.ts";
import {
  handoffPath,
  parseRequestDetails,
  parseSeedDetails,
  validateHandoff,
} from "../handoff/handoff-document.ts";

const STATUSES = ["done", "partial", "blocked"];

describe("validateHandoff", () => {
  it("accepts the sections in order with a status from the given list", () => {
    expect(validateHandoff(handoffDocument(HANDOFF_SECTIONS), STATUSES)).toEqual({
      ok: true,
      status: "partial",
    });
    expect(validateHandoff(handoffDocument({ ...HANDOFF_SECTIONS, Status: "**Done**" }), STATUSES)).toEqual({
      ok: true,
      status: "done",
    });
  });

  it("reports missing, empty and misordered sections", () => {
    const { Next: _next, ...withoutNext } = HANDOFF_SECTIONS;

    expect(validateHandoff(handoffDocument(withoutNext), STATUSES)).toEqual({
      ok: false,
      errors: ["missing sections: Next"],
    });
    expect(validateHandoff(handoffDocument({ ...HANDOFF_SECTIONS, Blocker: "" }), STATUSES)).toEqual({
      ok: false,
      errors: ["empty sections: Blocker"],
    });

    const { Status, ...rest } = HANDOFF_SECTIONS;
    const result = validateHandoff(handoffDocument({ ...rest, Status }), STATUSES);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors[0]).toContain("must appear in this order");
  });

  it("judges the status against the statuses it is given", () => {
    expect(
      validateHandoff(handoffDocument({ ...HANDOFF_SECTIONS, Status: "done" }), ["partial", "blocked"]),
    ).toEqual({
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

describe("parseSeedDetails", () => {
  it("reads a session or an agent origin", () => {
    expect(parseSeedDetails({ from: "session" })).toEqual({ from: "session" });
    expect(parseSeedDetails({ from: "agent", id: "a3", link: 2, extra: true })).toEqual({
      from: "agent",
      id: "a3",
      link: 2,
    });
  });

  it("rejects missing, unknown or incomplete details", () => {
    expect(parseSeedDetails(undefined)).toBeUndefined();
    expect(parseSeedDetails({ from: "elsewhere" })).toBeUndefined();
    expect(parseSeedDetails({ from: "agent", id: "a3" })).toBeUndefined();
  });
});

describe("parseRequestDetails", () => {
  it("reads a limit request with its figures, dropping figures that are not numbers", () => {
    expect(parseRequestDetails({ reason: "limit", tokens: 176_000, request: 175_000 })).toEqual({
      reason: "limit",
      tokens: 176_000,
      request: 175_000,
    });
    expect(parseRequestDetails({ reason: "limit", tokens: "many" })).toEqual({
      reason: "limit",
      tokens: undefined,
      request: undefined,
    });
  });

  it("reads a manual request only with its command label", () => {
    expect(parseRequestDetails({ reason: "manual", command: "/hand-over" })).toEqual({
      reason: "manual",
      command: "/hand-over",
    });
    expect(parseRequestDetails({ reason: "manual" })).toBeUndefined();
  });

  it("rejects unknown details", () => {
    expect(parseRequestDetails(undefined)).toBeUndefined();
    expect(parseRequestDetails({ reason: "other" })).toBeUndefined();
  });
});
