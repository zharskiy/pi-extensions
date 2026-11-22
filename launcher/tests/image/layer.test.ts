import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxConfig } from "../../config/index.ts";
import { ensureBuiltImage } from "../../image/build.ts";
import { ensureLayerImage } from "../../image/layer.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

type ImageConfig = SandboxConfig["image"];

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

const configWith = (image: Partial<ImageConfig>) => sandboxConfig({ image });

const extraDockerfile = async (text: string) => {
  const path = join(await tempDir(), "extra.Dockerfile");

  await writeFile(path, text);

  return path;
};

const layerDockerfile = (fake: ReturnType<typeof createFakeBackend>) =>
  fake.builds.at(-1)?.files.Dockerfile ?? "";

const layerFiles = (fake: ReturnType<typeof createFakeBackend>) => fake.builds.at(-1)?.files ?? {};

const certificate = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;

const pemFile = async (text: string) => {
  const path = join(await tempDir(), "ca.pem");

  await writeFile(path, text);

  return path;
};

describe("ensureLayerImage", () => {
  it("builds the layer with the trust steps when no layer key is set", async () => {
    const fake = createFakeBackend();
    const result = await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({}),
      stateDir: await tempDir(),
    });
    const text = layerDockerfile(fake);

    expect(result.built).toBe(true);
    expect(Object.keys(layerFiles(fake)).sort()).toEqual([
      "Dockerfile",
      "bash-env.sh",
      "entrypoint.sh",
      "forwarder.mjs",
      "jdk-net.properties",
      "trust-jdk.sh",
    ]);
    expect(text).toContain("COPY ca/ /usr/local/share/ca-certificates/pi-sandbox/");
    expect(text).toContain("COPY trust-jdk.sh jdk-net.properties /usr/local/lib/pi-sandbox/");
    expect(text).toMatch(/command -v update-ca-certificates[\s\S]+&& update-ca-certificates\n/);
    expect(text).toContain("RUN /usr/local/lib/pi-sandbox/trust-jdk.sh");
  });

  it("carries the entrypoint and the bash hint of this launcher, whatever base it builds on", async () => {
    const fake = createFakeBackend();

    await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({}),
      stateDir: await tempDir(),
    });

    const text = layerDockerfile(fake);
    const files = layerFiles(fake);

    expect(files["entrypoint.sh"]).toContain("sleep infinity");
    expect(files["bash-env.sh"]).toContain("command_not_found_handle");
    expect(text).toContain("COPY bash-env.sh forwarder.mjs /usr/local/lib/pi-sandbox/");
    expect(files["forwarder.mjs"]).toContain("node:net");
    expect(text).toContain("COPY entrypoint.sh /usr/local/bin/pi-sandbox-entrypoint");
    expect(text).toContain(
      "grep -qxF '. /usr/local/lib/pi-sandbox/bash-env.sh' /etc/bash.bashrc || { printf '%s\\n' '. /usr/local/lib/pi-sandbox/bash-env.sh' | cat - /etc/bash.bashrc",
    );
    expect(text).toContain("ENV BASH_ENV=/usr/local/lib/pi-sandbox/bash-env.sh");
    expect(text.indexOf("ENV BASH_ENV")).toBeLessThan(text.indexOf("ARG NODE_EXTRA_CA_CERTS"));
    expect(text.trimEnd().split("\n\n").slice(-2)).toEqual([
      'ENTRYPOINT ["/usr/local/bin/pi-sandbox-entrypoint"]',
      "CMD []",
    ]);
  });

  it("builds a layer without packages behind a parent proxy that needs credentials, since it fetches nothing", async () => {
    const fake = createFakeBackend();
    const env = { HTTPS_PROXY: "http://corp:secret@proxy.example.test:8080" };
    const stateDir = await tempDir();

    await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({}),
      stateDir,
      env,
    });

    expect(fake.builds.at(-1)?.args).toEqual({});
    await expect(
      ensureLayerImage({
        backend: fake.backend,
        baseImageId: BASE_ID,
        config: configWith({ packages: ["jq"] }),
        stateDir,
        env,
      }),
    ).rejects.toThrow("the parent proxy needs credentials");
  });

  it("builds a layer without packages offline and one with packages online", async () => {
    const fake = createFakeBackend();
    const { backend } = fake;
    const stateDir = await tempDir();

    await ensureLayerImage({ backend, baseImageId: BASE_ID, config: configWith({}), stateDir });
    await ensureLayerImage({
      backend,
      baseImageId: BASE_ID,
      config: configWith({ packages: ["jq"] }),
      stateDir,
    });

    expect(fake.builds.map((build) => build.offline)).toEqual([true, false]);
  });

  it("creates the CA folder before it sets its mode", async () => {
    const fake = createFakeBackend();

    await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({}),
      stateDir: await tempDir(),
    });

    const text = layerDockerfile(fake);

    expect(text).toContain("&& mkdir -p /usr/local/share/ca-certificates/pi-sandbox");
    expect(text.indexOf("mkdir -p /usr/local/share/ca-certificates/pi-sandbox")).toBeLessThan(
      text.indexOf("chmod 0755 /usr/local/share/ca-certificates/pi-sandbox"),
    );
  });

  it("writes the sandbox proxy into the JDK net.properties fragment", async () => {
    const fake = createFakeBackend();

    await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({}),
      stateDir: await tempDir(),
    });

    expect(layerFiles(fake)["jdk-net.properties"]).toBe(
      [
        "http.proxyHost=pi-sandbox-proxy",
        "http.proxyPort=3128",
        "https.proxyHost=pi-sandbox-proxy",
        "https.proxyPort=3128",
        "http.nonProxyHosts=localhost|127.*|[::1]|pi-sandbox-proxy",
        "",
      ].join("\n"),
    );
  });

  it("builds the layer on the base id from packages, npm globals and the extra Dockerfile text", async () => {
    const fake = createFakeBackend();
    const dockerfile = await extraDockerfile("RUN echo extra > /opt/extra\n");

    await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ packages: ["jq", "chromium=120.0"], npmGlobal: ["typescript@5.6.0"], dockerfile }),
      stateDir: await tempDir(),
    });

    const text = layerDockerfile(fake);
    const order = [
      `FROM ${BASE_ID}`,
      "USER root",
      "&& update-ca-certificates",
      "apt-get install -y --no-install-recommends chromium=120.0 jq",
      "npm install --global typescript@5.6.0",
      "RUN echo extra > /opt/extra",
      "RUN /usr/local/lib/pi-sandbox/trust-jdk.sh",
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
  });

  it("gives the same layer tag for the same packages in another order or repeated", async () => {
    const fake = createFakeBackend();
    const layerOf = async (image: Partial<ImageConfig>) =>
      ensureLayerImage({
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
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ npmGlobal: ["typescript@5.6.0"] }),
      stateDir: await tempDir(),
    });

    expect(layerDockerfile(fake)).not.toContain("apt-get");
    expect(layerDockerfile(fake)).toContain("npm install --global typescript@5.6.0");
  });

  it("puts the proxy CA and every extra CA into the context, one certificate per file", async () => {
    const fake = createFakeBackend();
    const proxyCaPem = await pemFile(`${certificate("proxy")}\n`);
    const trustPem = await pemFile(
      `${certificate("first")}\nnoise\n${certificate("second")}\n${certificate("first")}\n`,
    );

    await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({}),
      stateDir: await tempDir(),
      proxyCaPem,
      trustPem,
    });

    const certificates = Object.entries(layerFiles(fake)).filter(([name]) => name.startsWith("ca/"));

    expect(certificates.map(([name]) => name.replace(/-[0-9a-f]{12}\.crt$/, "")).sort()).toEqual([
      "ca/extra",
      "ca/extra",
      "ca/proxy",
    ]);
    expect(certificates.map(([, text]) => text).sort()).toEqual(
      [certificate("first"), certificate("proxy"), certificate("second")].map((pem) => `${pem}\n`),
    );
  });

  it("gives the layer another tag when a CA changes", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const tagWith = async (proxyCaPem: string) =>
      (
        await ensureLayerImage({
          backend: fake.backend,
          baseImageId: BASE_ID,
          config: configWith({}),
          stateDir,
          proxyCaPem,
        })
      ).tag;
    const first = await tagWith(await pemFile(certificate("old")));
    const second = await tagWith(await pemFile(certificate("new")));

    expect(second).not.toBe(first);
    expect(fake.builds).toHaveLength(2);
  });

  it("tags the layer by its inputs hash and records it as the current layer next to the base in image.json", async () => {
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
      backend: fake.backend,
      baseImageId: base.id,
      config,
      stateDir,
    });
    const record = JSON.parse(await readFile(join(stateDir, "image.json"), "utf8"));

    expect(layer.built).toBe(true);
    expect(layer.tag).toMatch(/^pi-sandbox-layer:[0-9a-f]{12}$/);
    expect(fake.builds.at(-1)?.tag).toBe(layer.tag);
    expect(record).toEqual({ base: expect.objectContaining({ id: base.id }), layer: layer.tag });
    expect(await readdir(stateDir)).toEqual(["image.json"]);

    const plain = await ensureLayerImage({
      backend: fake.backend,
      baseImageId: base.id,
      config: configWith({}),
      stateDir,
    });

    expect(plain.tag).not.toBe(layer.tag);
    expect(JSON.parse(await readFile(join(stateDir, "image.json"), "utf8"))).toEqual({
      base: record.base,
      layer: plain.tag,
    });
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
        backend: fake.backend,
        baseImageId: BASE_ID,
        config,
        stateDir: await tempDir(),
        env: { HTTPS_PROXY: "http://dev:secret@proxy.corp.example:3128" },
      }),
    ).rejects.toThrow(/parent proxy needs credentials/);
  });
});
