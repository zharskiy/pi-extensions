import { userInfo } from "node:os";
import { join, relative } from "node:path";
import { LABELS } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import { GUEST_PATHS, repoHash } from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { agentVolumeName, cacheVolumeName, sharedVolumeName, userHashOf } from "./names.ts";

export interface PathVolume {
  path: string;
  name: string;
}

type VolumeKey = "agent" | "mounts.autoOverlays" | "mounts.sharedCaches";

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

const overlayVolume = (workspace: Workspace, target: string): PlannedVolume => ({
  name: cacheVolumeName(workspace.repoRoot, repoRelative(workspace, target)),
  target,
  labels: { ...repoLabels(workspace), [LABELS.cachePath]: repoRelative(workspace, target) },
  key: "mounts.autoOverlays",
});

const overlayTargets = (workspace: Workspace, config: SandboxConfig) =>
  config.mounts.autoOverlays ? (workspace.overlays ?? []) : [];

export const overlayVolumes = (workspace: Workspace, config: SandboxConfig): PathVolume[] =>
  overlayTargets(workspace, config).map((path) => ({
    path,
    name: overlayVolume(workspace, path).name,
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
  ...overlayTargets(workspace, config).map((target) => overlayVolume(workspace, target)),
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
