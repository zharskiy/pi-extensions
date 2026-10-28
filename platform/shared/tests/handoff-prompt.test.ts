import { describe, expect, it } from "vitest";
import {
  type HandoffAudience,
  handoffInstruction,
  handoffRetry,
  seedText,
} from "../handoff/handoff-prompt.ts";

const PATH = "/tmp/pi-handoff/s1/main-handoff.md";

const SECTIONS = ["Status", "Outcome", "Evidence", "Blocker", "Next", "Files touched"];

const RICH: HandoffAudience = {
  statuses: ["done", "partial", "blocked"],
  statusHint: "for the goal",
  reader: "the reader",
  extraRules: ["Keep it brief."],
  nextHint: "End with the names.",
};

const PLAIN: HandoffAudience = {
  statuses: ["partial", "blocked"],
  statusHint: "",
  reader: "the successor",
  extraRules: [],
  nextHint: "",
};

const rich = (focus?: string) => handoffInstruction({ path: PATH, reason: "Full.", focus, audience: RICH });

const plain = () => handoffInstruction({ path: PATH, reason: "Stop now.", audience: PLAIN });

describe("handoff instruction", () => {
  it.each([
    ["rich", rich()],
    ["plain", plain()],
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

  it("lists the audience's statuses with its hint", () => {
    expect(rich()).toContain("One word for the goal: done, partial or blocked.");
    expect(plain()).toContain("One word: partial or blocked.");
  });

  it("starts from the reason and adds the audience's rules, reader and next hint", () => {
    expect(rich().startsWith("Full.")).toBe(true);
    expect(rich()).toContain("Do not start new work in this turn. Keep it brief.");
    expect(rich()).toContain("all that the reader will see");
    expect(rich()).toContain(
      "Concrete next steps for the reader, starting with the answer the user is waiting for, if any. End with the names.",
    );
    expect(plain().startsWith("Stop now.")).toBe(true);
    expect(plain()).toContain("Do not start new work in this turn.\n");
    expect(plain()).toContain("starting with the answer the user is waiting for, if any.\n");
  });

  it("gives a focus its own paragraph and leaves no gap without one", () => {
    expect(rich("ship the release")).toContain(
      "\n\nThe user says the next session is for: ship the release. Shape Outcome and Next around that and leave out what it does not need.\n\n",
    );
    expect(rich()).not.toContain("\n\n\n");
    expect(rich()).not.toContain("next session is for");
  });
});

describe("handoff retry", () => {
  it("repeats the instruction and lists each error", () => {
    const text = handoffRetry("write it", ["missing sections: Next", "empty sections: Blocker"]);

    expect(text.startsWith("write it\n")).toBe(true);
    expect(text).toContain(
      "The handoff was not accepted:\n- missing sections: Next\n- empty sections: Blocker",
    );
    expect(text.endsWith("Call the `handoff` tool again with the whole handoff fixed.")).toBe(true);
    expect(text).not.toContain("file");
  });
});

describe("seed text", () => {
  it("is the preface, a blank line and the trimmed handoff", () => {
    expect(seedText("Preface.", "\n## Status\npartial\n\n")).toBe("Preface.\n\n## Status\npartial");
  });
});
