import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, LauncherError } from "../../shared/index.ts";
import { repositoryOf, tagOf } from "../image-reference.ts";
import { missingImage, verifiedPull } from "../pull.ts";
import type { ImageInfo } from "../types.ts";
import { type EngineClient, segment } from "./engine-client.ts";

interface EngineImage {
  Id: string;
  RepoDigests?: string[] | null;
}

const repoDigests = (image: EngineImage) =>
  (image.RepoDigests ?? []).map((entry) => entry.slice(entry.indexOf("@") + 1));

const infoOf = (image: EngineImage, digest?: string): ImageInfo => ({
  id: image.Id,
  digest: digest ?? repoDigests(image)[0] ?? image.Id,
});

const accepts = (image: EngineImage, digest: string) => [...repoDigests(image), image.Id].includes(digest);

export const createImageOperations = (client: EngineClient, runner: CommandRunner) => {
  const inspect = async (reference: string) => {
    const response = await client.call({ method: "GET", path: `/images/${segment(reference)}/json` }, [404]);

    return response.status === 404 ? undefined : (JSON.parse(response.body.toString("utf8")) as EngineImage);
  };

  const pull = (reference: string, digest: string | undefined) =>
    client.progress({
      method: "POST",
      path: "/images/create",
      query: { fromImage: repositoryOf(reference), tag: digest ?? tagOf(reference) },
    });

  const resolveImage = async (reference: string) => {
    const image = await inspect(reference);

    return image === undefined ? undefined : infoOf(image);
  };

  const pullImage = (reference: string, digest?: string) =>
    verifiedPull(reference, digest, {
      inspect,
      pull: () => pull(reference, digest),
      accepts,
      digestOf: (image) => infoOf(image).digest,
      infoOf: (image) => infoOf(image, digest),
    });

  const archiveContext = async (contextDir: string, tarPath: string) => {
    const result = await runner.run("tar", ["-c", "-f", tarPath, "-C", contextDir, "."], {
      env: { COPYFILE_DISABLE: "1" },
    });

    if (result.code !== 0) {
      throw new LauncherError(`tar: cannot archive ${contextDir}: ${result.stderr.trim()}`);
    }
  };

  const buildQuery = (tag: string, buildArgs: Record<string, string>) => ({
    t: tag,
    rm: true,
    forcerm: true,
    ...(Object.keys(buildArgs).length === 0 ? {} : { buildargs: JSON.stringify(buildArgs) }),
  });

  const buildImage = async (contextDir: string, tag: string, buildArgs: Record<string, string> = {}) => {
    const workDir = await mkdtemp(join(tmpdir(), "pi-sandbox-build-"));
    const tarPath = join(workDir, "context.tar");

    try {
      await archiveContext(contextDir, tarPath);

      await client.progress({
        method: "POST",
        path: "/build",
        query: buildQuery(tag, buildArgs),
        stream: createReadStream(tarPath),
        contentType: "application/x-tar",
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }

    const built = await inspect(tag);

    if (built === undefined) {
      throw missingImage(tag, "build");
    }

    return infoOf(built, built.Id);
  };

  return { pullImage, resolveImage, buildImage };
};
