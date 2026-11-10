import { userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { LABELS } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { GUEST_PATHS, isWithin, repoHash } from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { agentVolumeName, cacheVolumeName, sharedVolumeName, userHashOf } from "./names.ts";

export interface PathVolume {
  path: string;
  name: string;
}

type VolumeKey = "agent" | "mounts.cacheVolumes" | "mounts.autoOverlays" | "mounts.sharedCaches";

export interface PlannedVolume {
  name: string;
  target: string;
  labels: Record<string, string>;
  key: VolumeKey;
}

export interface RepoVolumesInput {
  workspace: Workspace;
  config: SandboxConfig;
  uid: number;
}

export const GUEST_HOME = "/home/pi";

const hostUser = (uid: number) => {
  try {
    return userInfo().username;
  } catch {
    return String(uid);
  }
};

const homeRelative = (path: string) => path.slice(2).replace(/\/+$/, "");

const repoRelative = (workspace: Workspace, target: string) => relative(workspace.repoRoot, target) || ".";

const repoLabels = (workspace: Workspace) => ({
  [LABELS.repoHash]: repoHash(workspace.repoRoot),
  [LABELS.repoRoot]: workspace.repoRoot,
});

const cacheVolume = (workspace: Workspace, target: string, key: VolumeKey): PlannedVolume => ({
  name: cacheVolumeName(workspace.repoRoot, repoRelative(workspace, target)),
  target,
  labels: { ...repoLabels(workspace), [LABELS.cachePath]: repoRelative(workspace, target) },
  key,
});

const cacheTargets = (workspace: Workspace, config: SandboxConfig) => [
  ...new Set(config.mounts.cacheVolumes.map((path) => resolve(workspace.repoRoot, path))),
];

const overlayTargets = (workspace: Workspace, config: SandboxConfig) => {
  if (!config.mounts.autoOverlays) {
    return [];
  }

  const covered = cacheTargets(workspace, config);

  return (workspace.overlays ?? []).filter((path) => !covered.some((target) => isWithin(path, target)));
};

export const overlayVolumes = (workspace: Workspace, config: SandboxConfig): PathVolume[] =>
  overlayTargets(workspace, config).map((path) => ({
    path,
    name: cacheVolume(workspace, path, "mounts.autoOverlays").name,
  }));

export const sharedCacheVolumes = (config: SandboxConfig, stateDir: string): PathVolume[] =>
  config.mounts.sharedCaches.map((entry) => {
    const path = `~/${homeRelative(entry)}`;

    return { path, name: sharedVolumeName(userHashOf(stateDir), path) };
  });

const repoVolumePlan = ({ workspace, config, uid }: RepoVolumesInput): PlannedVolume[] => [
  {
    name: agentVolumeName(hostUser(uid), workspace.repoRoot),
    target: GUEST_PATHS.agentDir,
    labels: repoLabels(workspace),
    key: "agent",
  },
  ...cacheTargets(workspace, config).map((target) => cacheVolume(workspace, target, "mounts.cacheVolumes")),
  ...overlayTargets(workspace, config).map((target) => cacheVolume(workspace, target, "mounts.autoOverlays")),
];

const sharedVolumePlan = (config: SandboxConfig, stateDir: string): PlannedVolume[] =>
  sharedCacheVolumes(config, stateDir).map((cache) => ({
    name: cache.name,
    target: join(GUEST_HOME, homeRelative(cache.path)),
    labels: { [LABELS.userHash]: userHashOf(stateDir), [LABELS.sharedPath]: cache.path },
    key: "mounts.sharedCaches",
  }));

export const volumePlan = (input: RepoVolumesInput & { stateDir: string }): PlannedVolume[] => [
  ...repoVolumePlan(input),
  ...sharedVolumePlan(input.config, input.stateDir),
];

export const repoVolumes = (input: RepoVolumesInput) => repoVolumePlan(input).map((volume) => volume.name);
