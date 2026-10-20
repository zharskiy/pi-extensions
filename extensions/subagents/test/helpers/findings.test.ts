import { describe, expect, it } from "vitest";
import { citesFile, findingRefs, hitsLine, largestOutput, parseFindings } from "./findings.ts";

const REVIEW = [
  "Status: done",
  "",
  "**Findings:**",
  "- [high] extensions/session-limits/src/thresholds.ts:21 - hard uses Math.max - use Math.min",
  "- [medium] `src/limits.ts:40-44` - stale ratio - pass limits",
  "  continued explanation with other.ts:3 that is not an item",
  "- [low] README.md#L5 - wording - reword",
  "",
  "Verdict: do not ship",
  "- [high] after.ts:1 - outside the section - ignored",
].join("\n");

describe("parseFindings", () => {
  it("takes the item lines of the Findings section with severity and refs", () => {
    const findings = parseFindings(REVIEW);

    expect(findings.map((finding) => finding.severity)).toEqual(["high", "medium", "low"]);
    expect(findings.map((finding) => finding.refs)).toEqual([
      [{ path: "extensions/session-limits/src/thresholds.ts", start: 21, end: 21 }],
      [{ path: "src/limits.ts", start: 40, end: 44 }],
      [{ path: "README.md", start: 5, end: 5 }],
    ]);
  });

  it("reads a markdown heading section and stops at the next heading", () => {
    const text = ["## Findings", "1. [low] a.ts:2 - x - y", "## Verdict", "ship"].join("\n");

    expect(parseFindings(text).map((finding) => finding.text)).toEqual(["1. [low] a.ts:2 - x - y"]);
  });

  it("keeps an inline finding on the label line and returns none for an empty section", () => {
    expect(parseFindings("Findings: [high] a.ts:9 - bad - fix\nVerdict: ship")).toHaveLength(1);
    expect(parseFindings("Findings:\nnone\n\nVerdict: ship")).toEqual([]);
  });

  it("stops at a Verification section after the findings", () => {
    const text = [
      "Findings:",
      "1. [high] a.ts:3 - bad - fix",
      "Verification:",
      "- ran npm test b.test.ts:1",
      "- [low] read c.ts:7",
    ].join("\n");

    expect(parseFindings(text).map((finding) => finding.text)).toEqual(["1. [high] a.ts:3 - bad - fix"]);
  });

  it("falls back to severity-tagged lines without a Findings section", () => {
    const text = ["Review", "[medium] b.ts:4 - x - y", "plain line c.ts:5"].join("\n");

    expect(parseFindings(text).map((finding) => finding.refs[0]?.path)).toEqual(["b.ts"]);
  });
});

describe("findingRefs", () => {
  it("reads path:line, ranges, #L anchors and several refs per line", () => {
    expect(findingRefs("./a/b.ts:3–7 and c.tsx#L10-L12, also d.md:1")).toEqual([
      { path: "a/b.ts", start: 3, end: 7 },
      { path: "c.tsx", start: 10, end: 12 },
      { path: "d.md", start: 1, end: 1 },
    ]);
  });

  it("ignores paths without a line", () => {
    expect(findingRefs("see a/b.ts for details")).toEqual([]);
  });
});

describe("hitsLine", () => {
  const findings = parseFindings(REVIEW);
  const target = { file: "extensions/session-limits/src/thresholds.ts", line: 23, slack: 3 };

  it("matches the planted file within the slack, by full or suffix path", () => {
    expect(hitsLine(findings, target)).toBe(true);
    expect(hitsLine(findings, { ...target, file: "extensions/session-limits/src/limits.ts", line: 46 })).toBe(
      true,
    );
  });

  it("misses lines outside the slack and other files", () => {
    expect(hitsLine(findings, { ...target, line: 30 })).toBe(false);
    expect(hitsLine(findings, { ...target, file: "x/thresholds.ts" })).toBe(false);
  });

  it("strips the project root from absolute paths", () => {
    const absolute = parseFindings("Findings:\n- [high] /tmp/p/x/a.ts:5 - y - z");

    expect(hitsLine(absolute, { file: "x/a.ts", line: 5, slack: 0, roots: ["/tmp/p"] })).toBe(true);
  });
});

describe("citesFile", () => {
  it("matches a ref or a bare mention of the path", () => {
    const findings = parseFindings(
      "Findings:\n- [high] a/b.ts:3 - breaks the caller in `x/src/caller.ts` - fix\n- [low] src/other.ts:9 - y - z",
    );

    expect(citesFile(findings, "x/src/caller.ts")).toBe(true);
    expect(citesFile(findings, "pkg/src/other.ts")).toBe(true);
    expect(citesFile(findings, "x/src/missing.ts")).toBe(false);
  });
});

describe("largestOutput", () => {
  it("returns the longest text of the named tool, 0 when there is none", () => {
    const items = [
      { toolName: "bash", text: "12345" },
      { toolName: "read", text: "1234567890" },
      { toolName: "bash", text: "12" },
    ];

    expect(largestOutput(items, "bash")).toBe(5);
    expect(largestOutput(items, "grep")).toBe(0);
  });
});
