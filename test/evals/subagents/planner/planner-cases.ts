export type PlannerCase = {
  sha: string;
  request: string;
  expected: string[];
  unscored: string[];
  maxHelpers?: number;
};

export const plannerCases: PlannerCase[] = [
  {
    sha: "686fc95",
    request:
      "In session-limits, the handoff thresholds are only fractions of the context window, so on a 1M-token model the handoff comes far too late. Add absolute token caps next to the ratios (defaults 150k soft and 200k hard) so the effective threshold is whichever is lower, configurable in the settings file, and show token counts in the footer segment when the cap is the one that applies.",
    expected: [
      "extensions/session-limits/src/limits.ts",
      "extensions/session-limits/src/settings.ts",
      "extensions/session-limits/src/thresholds.ts",
    ],
    unscored: ["extensions/session-limits/src/index.ts"],
  },
  {
    sha: "00103e4",
    request:
      "In the footer, the thinking line reads `thinking high` with only the level in bold gold and the word `thinking` in the default colour. It is one mode indicator, so paint the whole `thinking <level>` label in the same bold gold; leave `thinking unavailable` and the cycle hint as they are.",
    expected: ["extensions/footer/src/render.ts"],
    unscored: ["extensions/footer/README.md"],
    maxHelpers: 0,
  },
  {
    sha: "aafb579",
    request:
      "When the composer or subagents install their custom editor, ↑ prompt history is lost on /reload and /new, and after /resume or /fork the earlier prompts of that session cannot be recalled either. pi's own editor keeps its history across all of these. Make our editor behave the same: keep the input history across reload and new, and on resume and fork seed it with the session's user messages.",
    expected: ["core/adapter/pi-editor.ts"],
    unscored: ["core/adapter/pi-adapter.ts", "ARCHITECTURE.md"],
  },
];
