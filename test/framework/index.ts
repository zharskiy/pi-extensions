export { startExtension } from "./extension-harness.ts";
export {
  catalogModel,
  createFakeAgentRuntime,
  type FakeAgentRuntime,
  type FakeChildSession,
} from "./fake-agent-runtime.ts";
export type { FakeForm } from "./fake-form.ts";
export {
  createFakeHost,
  createTurnScope,
  FAKE_FOOTER_KEY,
  type FakeHost,
  hiddenMessageTexts,
  requestTexts,
} from "./fake-host.ts";
export { char, key } from "./key-presses.ts";
export { reportCost, totalCost } from "./live/cost.ts";
export { fixtureMcpServerPath } from "./live/fixture-mcp-server-path.ts";
export {
  applyCommitDiff,
  type ExactEdit,
  replaceExactlyOnce,
  repoGit,
  seedProjectFromCommit,
} from "./live/seed-project.ts";
export { bashCommands, commandsLine, largestToolOutput } from "./live/session-reading.ts";
export {
  assistantToolCallLine,
  customLine,
  toolResultLine,
  userLine,
} from "./recorded-sessions.ts";
export { plainLines, plainText, visibleWidth } from "./rendered-text.ts";
export { useTempDirs } from "./temp-dirs.ts";
export { paintRecordingTheme, plainTheme, tokenTaggingTheme } from "./themes.ts";
export { promptTokens, usageTotals } from "./usage-builders.ts";
export { VALID_HANDOFF } from "./valid-handoff.ts";
export { flushMicrotasks, flushTimers, pause, waitUntil } from "./waiting.ts";
