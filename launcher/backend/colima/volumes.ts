import { LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import type { VolumeSummary } from "../types.ts";
import { labelFilters } from "./container-body.ts";
import { type EngineClient, segment } from "./engine-client.ts";

interface EngineVolume {
  Name: string;
}

export const createVolumeOperations = (client: EngineClient, install: string) => {
  const owned = { [LABELS.managed]: "true", [LABELS.install]: install };

  const ensureVolume = async (name: string) => {
    await client.call({
      method: "POST",
      path: "/volumes/create",
      json: { Name: name, Labels: owned },
    });
  };

  const listVolumes = async (): Promise<VolumeSummary[]> => {
    const listed = await client.json<{ Volumes?: EngineVolume[] | null }>({
      method: "GET",
      path: "/volumes",
      query: { filters: labelFilters(owned) },
    });

    return (listed.Volumes ?? []).map((volume) => ({ name: volume.Name }));
  };

  const removeVolume = async (name: string) => {
    const response = await client.call({ method: "DELETE", path: `/volumes/${segment(name)}` }, [404, 409]);

    if (response.status === 409) {
      throw new LauncherError(
        `volume ${name} is in use by a sandbox container`,
        "end the pi sessions that use it, then run the command again",
      );
    }
  };

  return { ensureVolume, listVolumes, removeVolume };
};
