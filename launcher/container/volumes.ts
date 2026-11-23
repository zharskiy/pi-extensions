import { relative } from "node:path";
import { installIdOf, LABELS } from "../backend/index.ts";
import { guestPathOf, type SandboxConfig, type ServiceEntry } from "../config/index.ts";
import { GUEST_PATHS, repoHash } from "../shared/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { agentVolumeName, cacheVolumeName, configVolumeName } from "./names.ts";

export interface PathVolume {
  path: string;
  name: string;
}

type VolumeKey = "agent" | "mounts.autoOverlays" | "mounts.volumes";

export interface PlannedVolume {
  name: string;
  target: string;
  labels: Record<string, string>;
  key: VolumeKey;
}

export interface RepoVolumesInput {
  workspace: Workspace;
  config: SandboxConfig;
  stateDir: string;
}

const repoRelative = (workspace: Workspace, target: string) => relative(workspace.repoRoot, target) || ".";

export const repoLabels = (repoRoot: string) => ({
  [LABELS.repoHash]: repoHash(repoRoot),
  [LABELS.repoRoot]: repoRoot,
});

const overlayVolume = (workspace: Workspace, stateDir: string, target: string): PlannedVolume => ({
  name: cacheVolumeName(installIdOf(stateDir), workspace.repoRoot, repoRelative(workspace, target)),
  target,
  labels: { ...repoLabels(workspace.repoRoot), [LABELS.cachePath]: repoRelative(workspace, target) },
  key: "mounts.autoOverlays",
});

const overlayTargets = (workspace: Workspace, config: SandboxConfig) =>
  config.mounts.autoOverlays ? (workspace.overlays ?? []) : [];

export const overlayVolumes = (workspace: Workspace, config: SandboxConfig, stateDir: string): PathVolume[] =>
  overlayTargets(workspace, config).map((path) => ({
    path,
    name: overlayVolume(workspace, stateDir, path).name,
  }));

export const configVolumes = (config: SandboxConfig) =>
  config.mounts.volumes.map((entry) => {
    const volume = typeof entry === "string" ? { target: entry } : entry;

    return {
      identity: volume.name ?? volume.target,
      target: guestPathOf(volume.target),
    };
  });

export const mountedVolumes = (config: SandboxConfig, stateDir: string) =>
  configVolumes(config).map((volume) => ({ ...volume, name: configVolumeName(stateDir, volume.identity) }));

export const serviceVolumeNames = (stateDir: string, services: ServiceEntry[]) =>
  new Set(
    services.flatMap((service) =>
      (service.volumes ?? []).map((entry) => configVolumeName(stateDir, entry.name)),
    ),
  );

const repoVolumePlan = ({ workspace, config, stateDir }: RepoVolumesInput): PlannedVolume[] => [
  {
    name: agentVolumeName(installIdOf(stateDir)),
    target: GUEST_PATHS.agentDir,
    labels: {},
    key: "agent",
  },
  ...overlayTargets(workspace, config).map((target) => overlayVolume(workspace, stateDir, target)),
];

const configVolumePlan = (config: SandboxConfig, stateDir: string): PlannedVolume[] =>
  mountedVolumes(config, stateDir).map((volume) => ({
    name: volume.name,
    labels: {},
    target: volume.target,
    key: "mounts.volumes",
  }));

export const volumePlan = (input: RepoVolumesInput): PlannedVolume[] => [
  ...repoVolumePlan(input),
  ...configVolumePlan(input.config, input.stateDir),
];
