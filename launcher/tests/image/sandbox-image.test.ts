import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSandboxImage } from "../../image/index.ts";
import type { SandboxImageInput } from "../../image/sandbox-image.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir, writeText } from "../support/temp-dir.ts";

const versions = { pi: "1.5.0" };

const inputOf = async (
  fake: ReturnType<typeof createFakeBackend>,
  overrides: Partial<SandboxImageInput> = {},
) => {
  const asked: string[] = [];
  const input: SandboxImageInput = {
    backend: fake.backend,
    config: sandboxConfig(),
    stateDir: await tempDir("sandbox-image"),
    repoHash: "a".repeat(64),
    versions: async () => {
      asked.push("versions");

      return versions;
    },
    inUse: async () => false,
    preparing: () => asked.push("preparing"),
    ...overrides,
  };

  return { input, asked };
};

describe("ensureSandboxImage", () => {
  it("builds once, announcing it, and then reuses the image a current container runs without resolving versions", async () => {
    const fake = createFakeBackend();
    const { input, asked } = await inputOf(fake);
    const first = await ensureSandboxImage(input);

    expect(asked).toEqual(["versions", "preparing"]);
    expect(fake.builds).toHaveLength(1);

    asked.length = 0;

    const second = await ensureSandboxImage({ ...input, inUse: async (digest) => digest === first.digest });

    expect(second).toEqual(first);
    expect(asked).toEqual([]);
    expect(fake.builds).toHaveLength(1);
  });

  it("announces nothing when the recorded build is reused or the pinned image is already local", async () => {
    const fake = createFakeBackend();
    const { input, asked } = await inputOf(fake);

    await ensureSandboxImage(input);

    asked.length = 0;

    await ensureSandboxImage(input);

    expect(asked).toEqual(["versions"]);
    expect(fake.builds).toHaveLength(1);

    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const registry = createFakeBackend({ registry: { [reference]: "sha256:pinned" } });
    const pinned = await inputOf(registry, {
      config: sandboxConfig({ image: { reference, digest: "sha256:pinned" } }),
    });

    await ensureSandboxImage(pinned.input);

    pinned.asked.length = 0;

    await ensureSandboxImage(pinned.input);

    expect(pinned.asked).toEqual([]);
  });

  it("pulls a pinned image without resolving versions", async () => {
    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const fake = createFakeBackend({ registry: { [reference]: "sha256:pinned" } });
    const { input, asked } = await inputOf(fake, {
      config: sandboxConfig({ image: { reference, digest: "sha256:pinned" } }),
    });

    expect(await ensureSandboxImage(input)).toEqual({
      reference,
      digest: "sha256:pinned",
      id: "sha256:image-pinned",
    });
    expect(asked).toEqual(["preparing"]);
    expect(fake.builds).toEqual([]);
  });

  it("puts the trust bundle into the build only when extra CAs are configured", async () => {
    const fake = createFakeBackend();
    const trustPem = join(await tempDir("sandbox-image-trust"), "extra.pem");

    await writeText(trustPem, "-----BEGIN CERTIFICATE-----\n");

    const plain = await inputOf(fake, { trustPem });

    await ensureSandboxImage(plain.input);

    const extra = await inputOf(fake, {
      trustPem,
      config: sandboxConfig({ tls: { extraCa: [{ file: trustPem }] } }),
    });

    await ensureSandboxImage(extra.input);

    expect(fake.builds.map((build) => build.files["trust.pem"])).toEqual([
      "",
      "-----BEGIN CERTIFICATE-----\n",
    ]);
  });

  it("returns the layer id on top of the base image when the config adds a layer", async () => {
    const fake = createFakeBackend();
    const { input } = await inputOf(fake, {
      config: sandboxConfig({ image: { ...sandboxConfig().image, npmGlobal: ["typescript@5.6.3"] } }),
    });
    const image = await ensureSandboxImage(input);

    expect(fake.builds.map((build) => build.tag)).toEqual([
      sandboxConfig().image.reference,
      expect.stringMatching(/^pi-sandbox-layer:/),
    ]);
    expect(image.digest).toBe("sha256:built-1");
    expect(image.id).not.toBe("sha256:image-built-1");
  });

  it("after a layer build removes the layer tags no container uses and that are not current, and keeps the base and an image in use", async () => {
    const fake = createFakeBackend();
    const { input } = await inputOf(fake);
    const withLayer = (spec: string) =>
      ensureSandboxImage({
        ...input,
        config: sandboxConfig({ image: { ...sandboxConfig().image, npmGlobal: [spec] } }),
      });
    const used = await withLayer("used@1.0.0");

    fake.addContainer({ name: "running", labels: {}, state: "running", image: used.id });

    const idle = await withLayer("idle@1.0.0");

    fake.ageImages(2 * 60 * 60);

    const current = await withLayer("current@1.0.0");
    const images = await fake.backend.listImages();
    const tagOf = (id: string) => images.find((image) => image.id === id)?.tags;

    expect(images.map((image) => image.id).sort()).toEqual(
      [used.id, current.id, "sha256:image-built-1"].sort(),
    );
    expect(tagOf("sha256:image-built-1")).toEqual([sandboxConfig().image.reference]);
    expect(tagOf(current.id)).toEqual([expect.stringMatching(/^pi-sandbox-layer:/)]);
    expect(idle.id).not.toBe(current.id);
  });

  it("removes the previous base image after a rebuild unless a container uses it", async () => {
    const fake = createFakeBackend();
    const { input } = await inputOf(fake);
    const first = await ensureSandboxImage(input);

    fake.ageImages(2 * 60 * 60);

    const rebuilt = await ensureSandboxImage({ ...input, versions: async () => ({ pi: "1.6.0" }) });

    expect((await fake.backend.listImages()).map((image) => image.id)).toEqual([rebuilt.id]);
    expect(fake.imageRemovals).toEqual([first.id]);

    fake.addContainer({ name: "running", labels: {}, state: "running", image: rebuilt.id });

    fake.ageImages(2 * 60 * 60);

    const third = await ensureSandboxImage({ ...input, versions: async () => ({ pi: "1.7.0" }) });

    expect((await fake.backend.listImages()).map((image) => image.id).sort()).toEqual(
      [rebuilt.id, third.id].sort(),
    );
  });

  it("keeps a layer tag built in the last hour that no container uses yet and removes an older one", async () => {
    const fake = createFakeBackend();
    const { input } = await inputOf(fake);
    const withLayer = (spec: string) =>
      ensureSandboxImage({
        ...input,
        config: sandboxConfig({ image: { ...sandboxConfig().image, npmGlobal: [spec] } }),
      });
    const old = await withLayer("old@1.0.0");

    fake.ageImages(2 * 60 * 60);

    const fresh = await withLayer("fresh@1.0.0");
    const current = await withLayer("current@1.0.0");
    const ids = (await fake.backend.listImages()).map((image) => image.id);

    expect(ids).toContain(fresh.id);
    expect(ids).toContain(current.id);
    expect(ids).not.toContain(old.id);
  });

  it("keeps an old layer another repository reuses before its container exists, because that repository's record names it", async () => {
    const fake = createFakeBackend();
    const { input } = await inputOf(fake);
    const withLayer = (repoHash: string, spec: string) =>
      ensureSandboxImage({
        ...input,
        repoHash,
        config: sandboxConfig({ image: { ...sandboxConfig().image, npmGlobal: [spec] } }),
      });
    const first = await withLayer("a".repeat(64), "first@1.0.0");

    fake.ageImages(2 * 60 * 60);

    const reused = await withLayer("a".repeat(64), "first@1.0.0");
    const other = await withLayer("b".repeat(64), "other@1.0.0");
    const ids = (await fake.backend.listImages()).map((image) => image.id);

    expect(reused.id).toBe(first.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(other.id);
  });
});
