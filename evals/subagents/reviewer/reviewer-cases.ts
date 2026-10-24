import type { ExactEdit } from "../../../test-framework/index.ts";

type Plant = ExactEdit;

export type ReviewerCase = { sha: string; plant: Plant; edits?: Plant[]; callSites?: string[] };

export const REVIEW_TASK =
  "I have uncommitted changes in this repo (see `git diff`). Review them before I commit: tell me what is wrong and whether it is good to ship.";

export const reviewerCases: ReviewerCase[] = [
  {
    sha: "686fc95",
    plant: {
      file: "extensions/session-limits/src/thresholds.ts",
      from: "hard: Math.min(window * limits.hardRatio, limits.hardTokens),",
      to: "hard: Math.max(window * limits.hardRatio, limits.hardTokens),",
    },
  },
  {
    sha: "0058777",
    plant: {
      file: "extensions/questionnaire/src/form.ts",
      from: 'if (!armed && (key.name === "enter" || digit !== undefined)) {',
      to: 'if (!armed && (key.name === "enter" && digit !== undefined)) {',
    },
  },
  {
    sha: "130e8d7",
    plant: {
      file: "extensions/spending/src/ledger.ts",
      from: "return cost >= 0 && tokens >= 0 && (cost > 0 || tokens > 0);",
      to: "return cost > 0 && tokens >= 0;",
    },
    edits: [
      {
        file: "extensions/spending/test/ledger.test.ts",
        from: 'expect(ledger.record({ source: "agents", id: "a1", usage: usageOf(0.5, 200) })).toBe(true);',
        to: 'expect(ledger.record({ source: "agents", id: "a1", usage: usageOf(0.6, 200) })).toBe(true);',
      },
      {
        file: "extensions/spending/README.md",
        from: "only when neither cost nor tokens go down and at least one goes up",
        to: "only when its cost goes up and its tokens do not go down",
      },
    ],
    callSites: ["extensions/subagents/src/plugins/usage-report/index.ts"],
  },
];
