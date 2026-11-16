export const VALID_HANDOFF = [
  "## Status",
  "partial",
  "",
  "## Outcome",
  "- auth handler located in src/auth.ts",
  "",
  "## Evidence",
  "- grep for handleLogin: src/auth.ts:42",
  "",
  "## Blocker",
  "none",
  "",
  "## Next",
  "- trace token refresh",
  "",
  "## Files touched",
  "none",
].join("\n");

export const handoffDocument = (sections: Record<string, string>) =>
  Object.entries(sections)
    .map(([title, body]) => `## ${title}\n${body}\n`)
    .join("\n");

export const HANDOFF_SECTIONS = {
  Status: "partial",
  Outcome: "- goal",
  Evidence: "- tests pass",
  Blocker: "none",
  Next: "- continue",
  "Files touched": "none",
};
