import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, LauncherError } from "../../shared/index.ts";
import { pinnedReference, repositoryOf, tagOf } from "../image-reference.ts";
import { LABELS } from "../labels.ts";
import type { ImageInfo, ImageSummary } from "../types.ts";
import { type EngineClient, segment } from "./engine-client.ts";

interface EngineImage {
  Id: string;
  RepoDigests?: string[] | null;
}

interface ListedImage {
  Id: string;
  RepoTags?: string[] | null;
  Labels?: Record<string, string> | null;
  Created?: number;
}

const NO_TAG = "<none>:<none>";

const BUILD_LABELS = JSON.stringify({ [LABELS.managed]: "true" });

const repoDigests = (image: EngineImage) =>
  (image.RepoDigests ?? []).map((entry) => entry.slice(entry.indexOf("@") + 1));

const infoOf = (image: EngineImage, digest?: string): ImageInfo => ({
  id: image.Id,
  digest: digest ?? repoDigests(image)[0] ?? image.Id,
});

const accepts = (image: EngineImage, digest: string) => [...repoDigests(image), image.Id].includes(digest);

const missingImage = (reference: string, after: "pull" | "build") =>
  new LauncherError(`image ${reference} is missing after ${after}`);

const digestMismatch = (reference: string, actual: string, expected: string) =>
  new LauncherError(
    `image ${reference} has digest ${actual}, expected ${expected}`,
    "update image.digest in the policy or publish the expected image",
  );

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

  const pullImage = async (reference: string, digest?: string) => {
    const target = digest === undefined ? reference : pinnedReference(reference, digest);
    const present = await inspect(target);

    if (present !== undefined && (digest === undefined || accepts(present, digest))) {
      return infoOf(present, digest);
    }

    await pull(reference, digest);

    const pulled = await inspect(target);

    if (pulled === undefined) {
      throw missingImage(target, "pull");
    }

    if (digest !== undefined && !accepts(pulled, digest)) {
      throw digestMismatch(target, infoOf(pulled).digest, digest);
    }

    return infoOf(pulled, digest);
  };

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
    labels: BUILD_LABELS,
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

  const usedImages = async () => {
    const containers = await client.json<Array<{ ImageID?: string }>>({
      method: "GET",
      path: "/containers/json",
      query: { all: true },
    });

    return new Set(
      containers.flatMap((container) => (container.ImageID === undefined ? [] : [container.ImageID])),
    );
  };

  const listImages = async (): Promise<ImageSummary[]> => {
    const images = await client.json<ListedImage[]>({ method: "GET", path: "/images/json" });
    const used = await usedImages();

    return images.map((image) => ({
      id: image.Id,
      tags: (image.RepoTags ?? []).filter((tag) => tag !== NO_TAG),
      labels: image.Labels ?? {},
      inUse: used.has(image.Id),
      created: image.Created ?? 0,
    }));
  };

  const removeImage = async (reference: string) => {
    const response = await client.call(
      { method: "DELETE", path: `/images/${segment(reference)}` },
      [404, 409],
    );

    return response.status < 300;
  };

  return { pullImage, resolveImage, buildImage, listImages, removeImage };
};
