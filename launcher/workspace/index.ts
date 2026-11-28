export { confirmBinds, type HostBind, hostBinds, hostVolumeSources, type VolumeSource } from "./binds.ts";
export { discoverWorkspace, workspaceFolder } from "./discover.ts";
export { assertHostSessionsDir, assertSafeMounts } from "./guard.ts";
export { type HostSessions, hostSessionsChoice, hostSessionsDir } from "./pi-session-dir.ts";
export {
  assertWithinHostRoot,
  assertWithinWorkspaceRoot,
  checkRoot,
  pathTextProblem,
  type RootGuardContext,
  type RootProblem,
  requiredRoot,
  rootRefusal,
  sharedRootOf,
} from "./roots.ts";
export { isSandboxWritable, sandboxWriteRoots } from "./sandbox-reach.ts";
export type { Workspace } from "./types.ts";
