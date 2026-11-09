export { removeCreatedDirs } from "./created.ts";
export { discoverWorkspace } from "./discover.ts";
export { assertGitIntegrity, pinGitDirs, unpinRecorded, withGitPinLock } from "./git/integrity.ts";
export { gitLaunchEndNotices, gitLaunchNotices, recordGitBaseline } from "./git/launch.ts";
export { findGitRoot } from "./git/layout.ts";
export {
  findProtectedGitPaths,
  type GitOverlay,
  type GitPathGuard,
  type GitProtectContext,
  gitPathGuard,
  type ProtectedGitPaths,
  protectedGitOverlay,
} from "./git/protect.ts";
export { workspaceNotices, workspaceSelfBinds } from "./git/workspace.ts";
export { assertHostSessionsDir, assertSafeWorkspace } from "./guard.ts";
export {
  createHostCacheDirs,
  type HostCache,
  hostCachePaths,
  resolveExtraMounts,
  resolveHostCaches,
} from "./mounts.ts";
export {
  type HostSessions,
  hostSessionsChoice,
  hostSessionsDir,
  sessionsSwitchNotice,
} from "./pi-session-dir.ts";
export { assertWithinWorkspaceRoots } from "./roots.ts";
export { gitRepos, mountedGitDirs, type Workspace } from "./types.ts";
