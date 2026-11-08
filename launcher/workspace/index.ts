export { discoverWorkspace } from "./discover.ts";
export { assertGitIntegrity, pinGitDirs, withGitPinLock } from "./git-integrity.ts";
export { findGitRoot, gitRefusal } from "./git-layout.ts";
export {
  findProtectedGitPaths,
  type GitOverlay,
  type GitPathGuard,
  type GitProtectContext,
  gitPathGuard,
  type ProtectedGitPaths,
  protectedGitOverlay,
} from "./git-protect.ts";
export { gitLaunchNotices, gitSessionEndNotices, recordGitBaseline } from "./git-session.ts";
export { workspaceNotices, workspaceSelfBinds } from "./git-workspace.ts";
export { assertHostSessionsDir, assertSafeWorkspace } from "./guard.ts";
export { resolveExtraMounts } from "./mounts.ts";
export {
  type HostSessions,
  hostAgentDir,
  hostSessionsChoice,
  hostSessionsDir,
  sessionSlug,
  sessionsSwitchNotice,
} from "./pi-session-dir.ts";
export { assertWithinWorkspaceRoots } from "./roots.ts";
export { gitRepos, mountedGitDirs, type Workspace } from "./types.ts";
export { scanWorkspace } from "./workspace-scan.ts";
