import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { type CommandRunner, errorMessage, LauncherError } from "../../shared/index.ts";
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

const BUILD_STEP = /^Step \d+\/\d+/;

const KEPT_OUTPUT_LINES = 30;

const CERTIFICATE_ERROR =
  /x509:|certificate verify failed|unable to get local issuer|self[- ]signed certificate|SSL certificate problem|certificate has expired|CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i;

const CERTIFICATE_HINT =
  "a proxy or CA on this network signs the downloads; set tls.extraCa to its CA, or image.digest to a prebuilt image";

const BUILD_LABELS = JSON.stringify({ [LABELS.managed]: "true" });

const repoDigests = (image: EngineImage) =>
  (image.RepoDigests ?? []).map((entry) => entry.slice(entry.indexOf("@") + 1));

const infoOf = (image: EngineImage, digest?: string): ImageInfo => ({
  id: image.Id,
  digest: digest ?? repoDigests(image)[0] ?? image.Id,
});

const outputOf = (line: Record<string, unknown>) =>
  typeof line.stream === "string" ? line.stream.split("\n").filter((text) => text.trim() !== "") : [];

const buildOutput = (report: (step: string) => void) => {
  const kept: string[] = [];

  const take = (line: Record<string, unknown>) => {
    const step = typeof line.stream === "string" ? BUILD_STEP.exec(line.stream) : null;

    if (step !== null) {
      report(step[0]);
    }

    kept.push(...outputOf(line));

    kept.splice(0, Math.max(0, kept.length - KEPT_OUTPUT_LINES));
  };

  return { take, kept };
};

const buildFailure = (error: unknown, output: string[]) => {
  const message = errorMessage(error);
  const text = [message, ...output.map((line) => `  ${line.trimEnd()}`)].join("\n");
  const evidence = [message, ...output.filter((line) => !BUILD_STEP.test(line))].join("\n");
  const hint = CERTIFICATE_ERROR.test(evidence) ? CERTIFICATE_HINT : undefined;

  return new LauncherError(text, hint ?? (error instanceof LauncherError ? error.hint : undefined));
};

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

  const buildImage = async (
    contextDir: string,
    tag: string,
    buildArgs: Record<string, string> = {},
    progress: (step: string) => void = () => undefined,
  ) => {
    const tarPath = `${contextDir}.tar`;
    const output = buildOutput(progress);

    try {
      await archiveContext(contextDir, tarPath);

      await client
        .progress(
          {
            method: "POST",
            path: "/build",
            query: buildQuery(tag, buildArgs),
            stream: createReadStream(tarPath),
            contentType: "application/x-tar",
          },
          output.take,
        )
        .catch((error: unknown) => Promise.reject(buildFailure(error, output.kept)));
    } finally {
      await rm(tarPath, { force: true });
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
    const [images, used] = await Promise.all([
      client.json<ListedImage[]>({ method: "GET", path: "/images/json" }),
      usedImages(),
    ]);

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
