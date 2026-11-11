export { removeCreatedDirs } from "./created.ts";
export { discoverWorkspace, workspaceFolder } from "./discover.ts";
export { assertGitIntegrity } from "./git/integrity.ts";
export {
  type GitLaunchContext,
  gitLaunchEndNotices,
  gitLaunchNotices,
  recordGitBaseline,
} from "./git/launch.ts";
export { findGitRoot } from "./git/layout.ts";
export {
  findProtectedGitPaths,
  type GitOverlay,
  type ProtectedGitPaths,
  protectedGitOverlay,
  protectedWorkspaceOverlay,
} from "./git/protect.ts";
export { workspaceNotices, workspaceSelfBinds } from "./git/workspace.ts";
export { assertHostSessionsDir, assertSafeMounts, assertSafeWorkspace } from "./guard.ts";
export { byDepth, unique } from "./paths.ts";
export { type HostSessions, hostSessionsChoice, hostSessionsDir } from "./pi-session-dir.ts";
export { assertWithinWorkspaceRoots } from "./roots.ts";
export { gitRepos, mountedGitDirs, type Workspace } from "./types.ts";
