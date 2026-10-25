import { describe, expect, it } from "vitest";
import {
  AGENT_AUDIENCE,
  AGENT_REASON,
  handoffInstruction,
  handoffRetry,
  handoffTemplate,
  MAIN_AUDIENCE,
  seedText,
  successorPreface,
} from "../handoff-prompt.ts";

const PATH = "/tmp/pi-handoff/s1/main-handoff.md";

const SECTIONS = ["Status", "Outcome", "Evidence", "Blocker", "Next", "Files touched"];

const main = (focus?: string) =>
  handoffInstruction(handoffTemplate(), { path: PATH, reason: "Full.", focus, audience: MAIN_AUDIENCE });

const agent = () =>
  handoffInstruction(handoffTemplate(), { path: PATH, reason: AGENT_REASON, audience: AGENT_AUDIENCE });

describe("handoff instruction", () => {
  it.each([
    ["main", main()],
    ["agent", agent()],
  ])("tells the %s audience to call the tool, lists the sections and ends with the reply line", (_, text) => {
    const positions = SECTIONS.map((section) => text.indexOf(`## ${section}`));

    expect(text).toContain(PATH);
    expect(text).toContain("Call the `handoff` tool");
    expect(positions.every((position, index) => position > (positions[index - 1] ?? -1))).toBe(true);
    expect(text).toContain("Do not start new work in this turn.");
    expect(text).toContain("unverified");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("{{");
    expect(text.endsWith("reply with one line: `handoff saved`.")).toBe(true);
  });

  it("offers done only to the main session", () => {
    expect(main()).toContain("done, partial or blocked");
    expect(main()).toContain("for the user's current goal");
    expect(agent()).toContain("One word: partial or blocked.");
    expect(agent()).not.toContain("done");
  });

  it("starts from the reason and adds the main session's own rules", () => {
    expect(main().startsWith("Full.")).toBe(true);
    expect(main()).toContain("the switch to the new session waits for it");
    expect(main()).toContain("`Skills: <names>`");
    expect(agent().startsWith(AGENT_REASON)).toBe(true);
    expect(agent()).not.toContain("Skills:");
    expect(agent()).not.toContain("background keeps running");
  });

  it("gives a focus its own paragraph and leaves no gap without one", () => {
    expect(main("ship the release")).toContain(
      "\n\nThe user says the next session is for: ship the release. Shape Outcome and Next around that and leave out what it does not need.\n\n",
    );
    expect(main()).not.toContain("\n\n\n");
    expect(main()).not.toContain("next session is for");
  });
});

describe("handoff retry", () => {
  it("repeats the instruction and lists each error", () => {
    const text = handoffRetry("write it", ["missing sections: Next", "empty sections: Blocker"]);

    expect(text.startsWith("write it\n")).toBe(true);
    expect(text).toContain("- missing sections: Next\n- empty sections: Blocker");
  });
});

describe("successor preface", () => {
  it("names the previous session file or says the previous session", () => {
    const named = successorPreface({ kind: "session", file: "/sessions/main.jsonl", manual: false });

    expect(named).toContain("the previous session /sessions/main.jsonl, which reached its context limit");
    expect(successorPreface({ kind: "session", manual: false })).toContain(
      "continues the previous session, which",
    );
  });

  it("names /session-handoff and repeats the focus only for a manual handoff", () => {
    const manual = successorPreface({ kind: "session", manual: true, focus: "ship the release" });

    expect(manual).toContain("which the user handed off with /session-handoff");
    expect(manual).toContain("The user said this session is for: ship the release.");
    expect(successorPreface({ kind: "session", manual: true })).not.toContain("this session is for");
    expect(successorPreface({ kind: "session", manual: false, focus: "x" })).not.toContain(
      "this session is for",
    );
  });

  it("ends the first paragraph of a session preface with the Next-section sentence", () => {
    const first = successorPreface({ kind: "session", manual: false }).split("\n")[0];

    expect(first.endsWith("Continue from its Next section without asking the user to repeat.")).toBe(true);
  });

  it("names the agent, the link and the saved path", () => {
    const text = successorPreface({ kind: "agent", id: "a3", link: 2, path: "/tmp/a3-handoff.md" });

    expect(text).toContain("agent a3 as link 2");
    expect(text).toContain("/tmp/a3-handoff.md");
    expect(text).toContain("Next section");
  });
});

describe("seed text", () => {
  it("is the preface, a blank line and the trimmed handoff", () => {
    expect(seedText("Preface.", "\n## Status\npartial\n\n")).toBe("Preface.\n\n## Status\npartial");
  });
});
