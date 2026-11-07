import { LauncherError } from "../shared/index.ts";
import { pinnedReference } from "./image-reference.ts";
import type { ImageInfo } from "./types.ts";

export const missingImage = (reference: string, after: "pull" | "build") =>
  new LauncherError(`image ${reference} is missing after ${after}`);

const digestMismatch = (reference: string, actual: string, expected: string) =>
  new LauncherError(
    `image ${reference} has digest ${actual}, expected ${expected}`,
    "update image.digest in the policy or publish the expected image",
  );

interface PullSteps<T> {
  inspect: (target: string) => Promise<T | undefined>;
  pull: (target: string) => Promise<unknown>;
  accepts: (found: T, digest: string) => boolean;
  digestOf: (found: T) => string;
  infoOf: (found: T, target: string) => ImageInfo;
}

export const verifiedPull = async <T>(
  reference: string,
  digest: string | undefined,
  steps: PullSteps<T>,
): Promise<ImageInfo> => {
  const target = digest === undefined ? reference : pinnedReference(reference, digest);
  const present = await steps.inspect(target);

  if (present !== undefined && (digest === undefined || steps.accepts(present, digest))) {
    return steps.infoOf(present, target);
  }

  await steps.pull(target);

  const pulled = await steps.inspect(target);

  if (pulled === undefined) {
    throw missingImage(target, "pull");
  }

  if (digest !== undefined && !steps.accepts(pulled, digest)) {
    throw digestMismatch(target, steps.digestOf(pulled), digest);
  }

  return steps.infoOf(pulled, target);
};
