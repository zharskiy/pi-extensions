import { type Backend, type ImageSummary, LABELS } from "../backend/index.ts";
import { shortHash, stateLayout, withFileLockIfFree } from "../shared/index.ts";
import { LAYER_TAG_PREFIX } from "./layer.ts";
import { currentLayer, readBaseRecord } from "./record.ts";

const SETTLE_SECONDS = 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const idle = (image: ImageSummary, now: number) => !image.inUse && now - image.created >= SETTLE_SECONDS;

const removeAll = async (backend: Backend, references: string[]) => {
  const removed = await Promise.all(
    references.map(async (reference) => ((await backend.removeImage(reference)) ? [reference] : [])),
  );

  return removed.flat();
};

const collectUnlocked = async (backend: Backend, stateDir: string, replacedBase?: string) => {
  const [images, layer, base] = await Promise.all([
    backend.listImages(),
    currentLayer(stateDir),
    readBaseRecord(stateDir),
  ]);
  const now = nowSeconds();
  const candidates = images.filter((image) => idle(image, now));
  const layerTags = candidates.flatMap((image) =>
    image.tags.filter((tag) => tag.startsWith(LAYER_TAG_PREFIX) && tag !== layer),
  );
  const untagged = candidates
    .filter(
      (image) =>
        image.tags.length === 0 &&
        image.id !== base?.id &&
        (image.labels[LABELS.managed] === "true" || image.id === replacedBase),
    )
    .map((image) => image.id);
  const tags = await removeAll(backend, layerTags);
  const ids = await removeAll(backend, untagged);

  return [...tags, ...ids.map((id) => shortHash(id.replace(/^sha256:/, "")))];
};

export const removeStaleImages = (backend: Backend, stateDir: string, replacedBase: string | undefined) =>
  collectUnlocked(backend, stateDir, replacedBase);

export const collectImages = async (backend: Backend, stateDir: string) => {
  const collected = await withFileLockIfFree(stateLayout(stateDir).buildLock, () =>
    collectUnlocked(backend, stateDir),
  );

  return collected.busy ? [] : collected.value;
};
