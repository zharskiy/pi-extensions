export {
  discoverGitOverlay,
  type GitGuardContext,
  type GitOverlay,
  gitLaunchNotices,
  gitSessionEndNotices,
  planGitOverlay,
  readyGitOverlay,
} from "./git-overlay.ts";
export {
  collectGarbage,
  ensureContainer,
  findCurrentContainer,
  findRepoContainer,
  gitDirInUseElsewhere,
  isCurrentContainer,
  policyHashesInUse,
  removeRepoContainer,
} from "./lifecycle.ts";
export { LABELS, userHashOf } from "./names.ts";
export type { CheckResult, ProbeTarget } from "./probes.ts";
export {
  answersHealth,
  checkNoRoute,
  checkSamePath,
  failed,
  passed,
  skipped,
  sweepCredentials,
  warned,
} from "./probes.ts";
export type { HostTerminal, SignalSource } from "./run-pi.ts";
export { listenFor, runPi } from "./run-pi.ts";
export type { LauncherContainerSpec } from "./spec.ts";
export {
  buildContainerSpec,
  forwardedEnv,
  nodeModulesOverlays,
  repoVolumes,
  sharedCacheVolumes,
} from "./spec.ts";
