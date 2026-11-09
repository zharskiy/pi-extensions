import { type Backend, type ImageSummary, LABELS } from "../backend/index.ts";
import { LAYER_TAG_PREFIX } from "./layer.ts";
import { readBaseRecord, wantedLayers } from "./record.ts";

const SETTLE_SECONDS = 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const settled = (image: ImageSummary, now: number) => now - image.created >= SETTLE_SECONDS;

const unreferencedLayerTags = (images: ImageSummary[], wanted: Set<string>, now: number) =>
  images
    .filter((image) => !image.inUse && settled(image, now))
    .flatMap((image) => image.tags.filter((tag) => tag.startsWith(LAYER_TAG_PREFIX) && !wanted.has(tag)));

const removeLayerTags = async (backend: Backend, stateDir: string, images: ImageSummary[], now: number) => {
  const tags = unreferencedLayerTags(images, await wantedLayers(stateDir), now);
  const removed = await Promise.all(tags.map(async (tag) => ((await backend.removeImage(tag)) ? [tag] : [])));

  return removed.flat();
};

export const removeStaleImages = async (
  backend: Backend,
  stateDir: string,
  replacedBase: string | undefined,
) => {
  const now = nowSeconds();
  const images = await backend.listImages();

  await removeLayerTags(backend, stateDir, images, now);

  const replaced = images.find((image) => image.id === replacedBase);

  if (replaced !== undefined && settled(replaced, now)) {
    await backend.removeImage(replaced.id);
  }
};

const isDangling = (image: ImageSummary, baseId: string | undefined) =>
  image.tags.length === 0 && !image.inUse && image.labels[LABELS.managed] === "true" && image.id !== baseId;

const removeDangling = async (backend: Backend, stateDir: string) => {
  const baseId = (await readBaseRecord(stateDir))?.id;
  const dangling = (await backend.listImages()).filter((image) => isDangling(image, baseId));
  const removed = await Promise.all(
    dangling.map(async (image) => ((await backend.removeImage(image.id)) ? [image.id] : [])),
  );

  return removed.flat().map((id) => id.replace(/^sha256:/, "").slice(0, 12));
};

export const collectImages = async (backend: Backend, stateDir: string) => {
  const tags = await removeLayerTags(backend, stateDir, await backend.listImages(), nowSeconds());

  return [...tags, ...(await removeDangling(backend, stateDir))];
};
