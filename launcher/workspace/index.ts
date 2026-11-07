export { discoverWorkspace } from "./discover.ts";
export { inertGitOptions } from "./git-command.ts";
export {
  assertGitIntegrity,
  gitAlternatesNotices,
  gitDirOf,
  pinGitDirs,
  unpinGitDirs,
  withGitPinLock,
} from "./git-integrity.ts";
export { findModuleGitDirs, findWorktreeGitDirs, gitRefusal } from "./git-layout.ts";
export { type GitBaseline, nestedGitNotices, scanGitBaseline } from "./git-scan.ts";
export { assertHostSessionsDir, assertSafeWorkspace } from "./guard.ts";
export { protectedPathGuard, resolveExtraMounts } from "./mounts.ts";
export {
  type HostSessions,
  hostAgentDir,
  hostSessionsChoice,
  hostSessionsDir,
  sessionSlug,
  sessionsSwitchNotice,
} from "./pi-session-dir.ts";
export { assertWithinWorkspaceRoots } from "./roots.ts";
export type { Workspace } from "./types.ts";
