import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { LauncherError } from "../../shared/index.ts";
import { LABELS } from "../labels.ts";
import { type EngineClient, segment } from "./engine-client.ts";

const VOLUME_TARGET = "/volume";

export const createVolumeOperations = (client: EngineClient) => {
  const ensureVolume = async (name: string) => {
    await client.call({
      method: "POST",
      path: "/volumes/create",
      json: { Name: name, Labels: { [LABELS.managed]: "true" } },
    });
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

  const assertVolume = async (name: string) => {
    const response = await client.call({ method: "GET", path: `/volumes/${segment(name)}` }, [404]);

    if (response.status === 404) {
      throw new LauncherError(`volume ${name} does not exist`);
    }
  };

  const createHelper = (name: string, imageId: string) =>
    client.json<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      json: {
        Image: imageId,
        Cmd: ["true"],
        Labels: { [LABELS.helper]: "volume" },
        HostConfig: {
          NetworkMode: "none",
          Mounts: [{ Type: "volume", Source: name, Target: VOLUME_TARGET, ReadOnly: false }],
        },
      },
    });

  const withHelper = async (
    name: string,
    imageId: string,
    action: (containerId: string) => Promise<unknown>,
  ) => {
    const helper = await createHelper(name, imageId);

    try {
      await action(helper.Id);
    } finally {
      await client.call(
        { method: "DELETE", path: `/containers/${segment(helper.Id)}`, query: { force: true } },
        [404],
      );
    }
  };

  const exportVolume = async (name: string, tarPath: string, imageId: string) => {
    await assertVolume(name);

    await withHelper(name, imageId, (containerId) =>
      client.download(
        {
          method: "GET",
          path: `/containers/${segment(containerId)}/archive`,
          query: { path: VOLUME_TARGET },
        },
        tarPath,
      ),
    );
  };

  const assertArchive = async (tarPath: string) => {
    try {
      await stat(tarPath);
    } catch {
      throw new LauncherError(`volume archive ${tarPath} does not exist`);
    }
  };

  const importVolume = async (name: string, tarPath: string, imageId: string) => {
    await assertArchive(tarPath);

    await ensureVolume(name);

    await withHelper(name, imageId, (containerId) =>
      client.call({
        method: "PUT",
        path: `/containers/${segment(containerId)}/archive`,
        query: { path: "/" },
        stream: createReadStream(tarPath),
        contentType: "application/x-tar",
      }),
    );
  };

  return { ensureVolume, removeVolume, exportVolume, importVolume };
};
