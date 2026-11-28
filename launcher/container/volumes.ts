import { installIdOf } from "../backend/index.ts";
import { guestPathOf, type SandboxConfig, type ServiceEntry } from "../config/index.ts";
import { GUEST_PATHS } from "../shared/index.ts";
import { agentVolumeName, configVolumeName } from "./names.ts";

type VolumeKey = "agent" | "mounts.volumes";

export interface PlannedVolume {
  name: string;
  target: string;
  key: VolumeKey;
}

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

export const volumePlan = (config: SandboxConfig, stateDir: string): PlannedVolume[] => [
  {
    name: agentVolumeName(installIdOf(stateDir)),
    target: GUEST_PATHS.agentDir,
    key: "agent",
  },
  ...mountedVolumes(config, stateDir).map((volume) => ({
    name: volume.name,
    target: volume.target,
    key: "mounts.volumes" as const,
  })),
];
