import { LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import type { VolumeSummary } from "../types.ts";
import { labelFilters } from "./container-body.ts";
import { type EngineClient, segment } from "./engine-client.ts";

interface EngineVolume {
  Name: string;
  Labels?: Record<string, string> | null;
}

interface EngineMount {
  Type?: string;
  Name?: string;
}

export const createVolumeOperations = (client: EngineClient) => {
  const ensureVolume = async (name: string, labels: Record<string, string> = {}) => {
    await client.call({
      method: "POST",
      path: "/volumes/create",
      json: { Name: name, Labels: { ...labels, [LABELS.managed]: "true" } },
    });
  };

  const mountedVolumes = async () => {
    const containers = await client.json<Array<{ Mounts?: EngineMount[] | null }>>({
      method: "GET",
      path: "/containers/json",
      query: { all: true },
    });

    return new Set(
      containers.flatMap((container) =>
        (container.Mounts ?? []).flatMap((mount) =>
          mount.Type === "volume" && mount.Name !== undefined ? [mount.Name] : [],
        ),
      ),
    );
  };

  const listVolumes = async (): Promise<VolumeSummary[]> => {
    const listed = await client.json<{ Volumes?: EngineVolume[] | null }>({
      method: "GET",
      path: "/volumes",
      query: { filters: labelFilters({ [LABELS.managed]: "true" }) },
    });
    const mounted = await mountedVolumes();

    return (listed.Volumes ?? []).map((volume) => ({
      name: volume.Name,
      labels: volume.Labels ?? {},
      inUse: mounted.has(volume.Name),
    }));
  };

  const removeVolume = async (name: string) => {
    const response = await client.call({ method: "DELETE", path: `/volumes/${segment(name)}` }, [404, 409]);

    if (response.status === 409) {
      throw new LauncherError(
        `volume ${name} is in use`,
        "stop the sandbox container first: pi sandbox reset",
      );
    }
  };

  return { ensureVolume, listVolumes, removeVolume };
};
