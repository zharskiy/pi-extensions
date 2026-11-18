import { describe, expect, it } from "vitest";
import { collectImages } from "../../image/index.ts";
import { stateLayout, withFileLock, writeJsonFile } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { tempDir } from "../support/temp-dir.ts";

const HOUR_AND_MORE = 2 * 60 * 60;

const danglingImage = async (fake: ReturnType<typeof createFakeBackend>) => {
  const context = await tempDir("prune-context");
  const first = await fake.backend.buildImage(context, "pi-sandbox-layer:old");

  await fake.backend.buildImage(context, "pi-sandbox-layer:old");

  return first;
};

describe("collectImages", () => {
  it("removes a dangling managed image older than an hour", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir("prune-state");
    const dangling = await danglingImage(fake);

    fake.ageImages(HOUR_AND_MORE);

    expect(await collectImages(fake.backend, stateDir)).toContain(
      dangling.id.replace(/^sha256:/, "").slice(0, 12),
    );
    expect(fake.imageRemovals).toContain(dangling.id);
  });

  it("keeps a dangling managed image younger than an hour", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir("prune-state");
    const dangling = await danglingImage(fake);

    expect(await collectImages(fake.backend, stateDir)).toEqual([]);
    expect(fake.imageRemovals).not.toContain(dangling.id);
  });

  it("collects an earlier layer tag and never an image a container uses or the current layer, however old", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir("prune-state");
    const context = await tempDir("prune-context");
    const used = await fake.backend.buildImage(context, "pi-sandbox-layer:used");
    const wanted = await fake.backend.buildImage(context, "pi-sandbox-layer:wanted");

    await fake.backend.buildImage(context, "pi-sandbox-layer:earlier");

    fake.addContainer({ name: "running", labels: {}, state: "running", image: used.id });

    await writeJsonFile(stateLayout(stateDir).imageRecord, { layer: "pi-sandbox-layer:wanted" });

    fake.ageImages(HOUR_AND_MORE);

    expect(await collectImages(fake.backend, stateDir)).toEqual(["pi-sandbox-layer:earlier"]);

    const left = await fake.backend.listImages();

    expect(left.map((image) => image.id)).toEqual(expect.arrayContaining([used.id, wanted.id]));
    expect(left.flatMap((image) => image.tags).sort()).toEqual([
      "pi-sandbox-layer:used",
      "pi-sandbox-layer:wanted",
    ]);
  });

  it("removes nothing while an image build holds the build lock", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir("prune-state");

    await danglingImage(fake);

    fake.ageImages(HOUR_AND_MORE);

    const collected = await withFileLock(stateLayout(stateDir).buildLock, () =>
      collectImages(fake.backend, stateDir),
    );

    expect(collected).toEqual([]);
    expect(fake.imageRemovals).toEqual([]);
  });
});
