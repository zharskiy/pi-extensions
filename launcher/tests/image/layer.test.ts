import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxConfig } from "../../config/index.ts";
import { ensureBuiltImage } from "../../image/build.ts";
import { ensureLayerImage } from "../../image/layer.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const REPO = "a".repeat(64);

type ImageConfig = SandboxConfig["image"];

const REFERENCE = "ghcr.io/zharskiy/pi-sandbox:0.4.0";

const BASE_ID = "sha256:image-base";

const dirs: string[] = [];

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-layer-"));

  dirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const configWith = (image: Partial<ImageConfig>) =>
  sandboxConfig({ image: { reference: REFERENCE, ...image } });

const extraDockerfile = async (text: string) => {
  const path = join(await tempDir(), "extra.Dockerfile");

  await writeFile(path, text);

  return path;
};

const layerDockerfile = (fake: ReturnType<typeof createFakeBackend>) =>
  fake.builds.at(-1)?.files.Dockerfile ?? "";

describe("ensureLayerImage", () => {
  it("uses the base image as is when no layer key is set", async () => {
    const fake = createFakeBackend();
    const result = await ensureLayerImage({
      repoHash: REPO,
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({}),
      stateDir: await tempDir(),
    });

    expect(result).toEqual({ id: BASE_ID, built: false });
    expect(fake.builds).toEqual([]);
  });

  it("builds the layer on the base id from packages, npm globals and the extra Dockerfile text", async () => {
    const fake = createFakeBackend();
    const dockerfile = await extraDockerfile("RUN echo extra > /opt/extra\n");

    await ensureLayerImage({
      repoHash: REPO,
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ packages: ["jq", "chromium=120.0"], npmGlobal: ["typescript@5.6.0"], dockerfile }),
      stateDir: await tempDir(),
    });

    const text = layerDockerfile(fake);
    const order = [
      `FROM ${BASE_ID}`,
      "USER root",
      "apt-get install -y --no-install-recommends chromium=120.0 jq",
      "npm install --global typescript@5.6.0",
      "RUN echo extra > /opt/extra",
      "USER pi",
    ].map((step) => text.indexOf(step));

    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.trimEnd().split("\n\n").slice(-4)).toEqual([
      "USER pi",
      "WORKDIR /home/pi",
      'ENTRYPOINT ["/usr/local/bin/pi-sandbox-entrypoint"]',
      "CMD []",
    ]);
    expect(text).toMatch(/^ARG NODE_EXTRA_CA_CERTS=/m);
    expect(Object.keys(fake.builds.at(-1)?.files ?? {}).sort()).toEqual(["Dockerfile", "trust.pem"]);
  });

  it("gives the same layer tag for the same packages in another order or repeated", async () => {
    const fake = createFakeBackend();
    const layerOf = async (image: Partial<ImageConfig>) =>
      ensureLayerImage({
        repoHash: REPO,
        backend: fake.backend,
        baseImageId: BASE_ID,
        config: configWith(image),
        stateDir: await tempDir(),
      });
    const first = await layerOf({ packages: ["jq", "chromium"], npmGlobal: ["b@1.0.0", "a@1.0.0"] });
    const second = await layerOf({
      packages: ["chromium", "jq", "jq"],
      npmGlobal: ["a@1.0.0", "b@1.0.0", "a@1.0.0"],
    });

    expect(second.tag).toBe(first.tag);
    expect(second.built).toBe(false);
    expect(fake.builds).toHaveLength(1);
    expect(layerDockerfile(fake)).toContain("npm install --global a@1.0.0 b@1.0.0");
  });

  it("reads an image.dockerfile path that starts with ~/ from the home", async () => {
    const fake = createFakeBackend();
    const home = await tempDir();

    await writeFile(join(home, "layer.Dockerfile"), "RUN echo from-home > /opt/home\n");

    await ensureLayerImage({
      repoHash: REPO,
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ dockerfile: "~/layer.Dockerfile" }),
      stateDir: await tempDir(),
      env: { HOME: home },
    });

    expect(layerDockerfile(fake)).toContain("RUN echo from-home > /opt/home");
  });

  it("leaves out the steps whose keys are not set", async () => {
    const fake = createFakeBackend();

    await ensureLayerImage({
      repoHash: REPO,
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ npmGlobal: ["typescript@5.6.0"] }),
      stateDir: await tempDir(),
    });

    expect(layerDockerfile(fake)).not.toContain("apt-get");
    expect(layerDockerfile(fake)).toContain("npm install --global typescript@5.6.0");
  });

  it("puts the trust bundle into the build context", async () => {
    const fake = createFakeBackend();
    const trustPem = join(await tempDir(), "trust.pem");

    await writeFile(trustPem, "corporate root\n");
    await ensureLayerImage({
      repoHash: REPO,
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ packages: ["jq"] }),
      stateDir: await tempDir(),
      trustPem,
    });

    expect(fake.builds.at(-1)?.files["trust.pem"]).toBe("corporate root\n");
  });

  it("tags the layer by its inputs hash and keeps only the base image in image.json", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = configWith({ packages: ["jq"] });
    const base = await ensureBuiltImage({
      backend: fake.backend,
      config,
      versions: { pi: "1.5.0" },
      stateDir,
    });
    const layer = await ensureLayerImage({
      repoHash: REPO,
      backend: fake.backend,
      baseImageId: base.id,
      config,
      stateDir,
    });
    const record = JSON.parse(await readFile(join(stateDir, "image.json"), "utf8"));

    expect(layer.built).toBe(true);
    expect(layer.tag).toMatch(/^pi-sandbox-layer:[0-9a-f]{12}$/);
    expect(fake.builds.at(-1)?.tag).toBe(layer.tag);
    expect(Object.keys(record)).toEqual(["base"]);
    expect(record.base).toMatchObject({ id: base.id });
    expect((await readdir(stateDir)).sort()).toEqual(["image.json", "repos"]);
  });

  it("reuses the layer tagged by its inputs and rebuilds when a key or the base changes", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = configWith({ packages: ["jq"] });
    const base = await ensureBuiltImage({
      backend: fake.backend,
      config,
      versions: { pi: "1.5.0" },
      stateDir,
    });
    const ensure = (baseImageId: string, image: Partial<ImageConfig>) =>
      ensureLayerImage({
        repoHash: REPO,
        backend: fake.backend,
        baseImageId,
        config: configWith(image),
        stateDir,
      });
    const first = await ensure(base.id, { packages: ["jq"] });
    const again = await ensure(base.id, { packages: ["jq"] });
    const changed = await ensure(base.id, { packages: ["jq", "curl"] });
    const rebased = await ensure("sha256:image-other", { packages: ["jq", "curl"] });

    expect(again).toEqual({ ...first, built: false });
    expect(changed.built).toBe(true);
    expect(changed.tag).not.toBe(first.tag);
    expect(rebased.tag).not.toBe(changed.tag);
    expect(fake.builds.filter((build) => build.tag.startsWith("pi-sandbox-layer:"))).toHaveLength(3);
  });

  it("refuses a parent proxy with credentials when it has to build the layer", async () => {
    const fake = createFakeBackend();
    const config = configWith({ packages: ["jq"] });

    await expect(
      ensureLayerImage({
        repoHash: REPO,
        backend: fake.backend,
        baseImageId: BASE_ID,
        config,
        stateDir: await tempDir(),
        env: { HTTPS_PROXY: "http://dev:secret@proxy.corp.example:3128" },
      }),
    ).rejects.toThrow(/parent proxy needs credentials/);
  });
});
