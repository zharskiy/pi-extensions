import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkProposal,
  PROPOSAL_TOOL,
  type ProposalParams,
  proposalDefinition,
  proposalUnchanged,
  savedText,
} from "../../../core/agent-setup/proposal.ts";
import { PACKAGE_ROOT } from "../../support/subagents-harness.ts";

const KNOWN = {
  agents: ["general", "planner", "reviewer", "scout"],
  leads: ["planner", "reviewer"],
  skills: ["docs", "search", "lint", "tests"],
  interactive: ["asker"],
};

const proposal = (assignments: ProposalParams["assignments"], reasons: ProposalParams["reasons"] = []) =>
  checkProposal({ project: "A web app", assignments, reasons }, KNOWN);

describe("proposalDefinition", () => {
  it("is a model-only sequential tool without a prompt snippet", () => {
    expect(proposalDefinition).toMatchObject({
      name: PROPOSAL_TOOL,
      modelOnly: true,
      executionMode: "sequential",
    });
    expect(proposalDefinition).not.toHaveProperty("promptSnippet");
  });

  it("is the tool the brief names", () => {
    const template = readFileSync(join(PACKAGE_ROOT, "prompts", "autosetup-skills.md"), "utf8");

    expect(template).toContain(PROPOSAL_TOOL);
    expect(template.match(/\{\{(\w+)\}\}/g)).toEqual([
      "{{project}}",
      "{{listing}}",
      "{{leads}}",
      "{{skills}}",
    ]);
  });
});

describe("checkProposal", () => {
  it("keeps the order, drops repeated skills and joins the reasons into a note", () => {
    const result = proposal(
      [{ lead: "reviewer", skills: ["search", "docs", "search"] }],
      [
        { skill: "docs", why: "writes the docs" },
        { skill: "search", why: "finds prior art" },
        { skill: "lint", why: "not proposed" },
      ],
    );

    expect(result).toEqual({
      project: "A web app",
      lists: { reviewer: ["search", "docs"] },
      notes: { reviewer: "search: finds prior art; docs: writes the docs" },
    });
  });

  it("refuses non-leads without saying why", () => {
    const result = proposal([
      { lead: "general", skills: [] },
      { lead: "scout", skills: [] },
    ]);

    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toContain(
      "general is not set up here; scout is not set up here",
    );
    expect("error" in result && result.error).not.toContain("chore");
  });

  it("lists every problem at once with the names it accepts", () => {
    const result = checkProposal(
      {
        project: " ",
        assignments: [
          { lead: "nobody", skills: [] },
          { lead: "planner", skills: ["ghost"] },
          { lead: "reviewer", skills: ["docs", "search", "lint", "tests"] },
          { lead: "reviewer", skills: [] },
        ],
        reasons: [],
      },
      KNOWN,
    );

    expect(result).toEqual({
      error:
        "Error: project: say in one line what kind of project this is; reviewer is listed more than once; " +
        'no agent named "nobody"; no skill named "ghost" here; reviewer: at most 3 skills. ' +
        "Lead agents: planner, reviewer. Skills: docs, search, lint, tests. Fix the call and call again.",
    });
  });

  it("refuses a skill left out as interactive with its own reason", () => {
    const result = proposal([{ lead: "planner", skills: ["asker", "ghost"] }]);

    expect("error" in result && result.error).toContain(
      '"asker" asks the user; agents cannot use it; no skill named "ghost" here',
    );
  });
});

describe("proposalUnchanged", () => {
  it("compares the lists in order", () => {
    const current = { planner: ["docs", "search"], reviewer: [] } as Record<string, string[]>;
    const read = (lead: string) => current[lead];
    const same = proposal([{ lead: "planner", skills: ["docs", "search"] }]);
    const reordered = proposal([{ lead: "planner", skills: ["search", "docs"] }]);
    const changed = proposal([{ lead: "reviewer", skills: ["docs"] }]);

    expect("error" in same || proposalUnchanged(same, read)).toBe(true);
    expect("error" in reordered || proposalUnchanged(reordered, read)).toBe(false);
    expect("error" in changed || proposalUnchanged(changed, read)).toBe(false);
    expect("error" in changed || proposalUnchanged(changed, () => "all")).toBe(false);
  });
});

describe("savedText", () => {
  it("names what was saved and asks for a new session", () => {
    const text = savedText("/p.json", [
      { name: "reviewer", patch: { skills: ["search", "docs"] } },
      { name: "scout", patch: { thinking: "low" } },
    ]);

    expect(text).toBe(
      "Saved to /p.json: reviewer skills [search, docs]; scout thinking low. Agents started from now on use them. " +
        "Tell the user what was saved, and suggest they start a new session with /new to free the tokens the setup took.",
    );
  });

  it("carries the shadow warning", () => {
    expect(
      savedText("/u.json", [{ name: "reviewer", patch: { skills: [] } }], "/p.json also sets x and wins"),
    ).toContain("Note: /p.json also sets x and wins.");
  });
});
