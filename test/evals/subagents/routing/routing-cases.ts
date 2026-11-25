export type RoutingCase = {
  request: string;
  agent?: string;
  never?: string;
  skill?: string;
  direct?: boolean;
};

export const BRIEF_FIELDS = ["Goal", "Scope", "Done when", "Return"];

export const SKILL = "tdd";

export const routingCases: RoutingCase[] = [
  { request: "where do we parse the settings file?", agent: "scout", direct: true },
  {
    request: "rename the `renderThrottleMs` setting to `redrawThrottleMs` in extensions/subagents",
    agent: "implementer",
  },
  { request: "review my last commit", agent: "reviewer" },
  { request: "make the subagents extension support cancelling a batch", agent: "planner" },
  { request: "what does https://example.com say?", agent: "fetch" },
  { request: "run npm run test and tell me what fails", agent: "shell" },
  { request: "everything is changed and reviewed; run the project's checks", agent: "verifier" },
  {
    request:
      "[pi-subagents] Batch b1 finished: 1 done.\n\n## a1-1 (implementer) - done\n\nStatus: done\nChanges:\nsrc/time.ts - parseDuration accepts `1h30m`\nVerification: none\nOpen: none",
    agent: "reviewer",
    never: "verifier",
  },
  {
    request:
      "[pi-subagents] Batch b3 finished: 1 done.\n\n## a3-1 (implementer) - done\n\nStatus: done\nChanges:\nsrc/time.ts - fixes the findings of reviewer a2-1: parseDuration rejects `1h-5m`\nVerification: none\nOpen: none",
    agent: "verifier",
    never: "reviewer",
  },
  { request: "what does screenshot.png show?", agent: "image" },
  { request: "draft release notes from the git log", agent: "general" },
  { request: `use my ${SKILL} skill to add a test for parseDuration in src/time.ts`, skill: SKILL },
];
