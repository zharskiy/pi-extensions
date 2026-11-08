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
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ packages: ["jq", "chromium=120.0"], npmGlobal: ["typescript@5.6.0"], dockerfile }),
      stateDir: await tempDir(),
    });

    const text = layerDockerfile(fake);
    const order = [
      `FROM ${BASE_ID}`,
      "USER root",
      "apt-get install -y --no-install-recommends jq chromium=120.0",
      "npm install --global typescript@5.6.0",
      "RUN echo extra > /opt/extra",
      "USER pi",
    ].map((step) => text.indexOf(step));

    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.trimEnd().endsWith("USER pi")).toBe(true);
    expect(text).toMatch(/^ARG NODE_EXTRA_CA_CERTS=/m);
    expect(Object.keys(fake.builds.at(-1)?.files ?? {}).sort()).toEqual(["Dockerfile", "trust.pem"]);
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

  it("puts the trust bundle into the build context", async () => {
    const fake = createFakeBackend();
    const trustPem = join(await tempDir(), "trust.pem");

    await writeFile(trustPem, "corporate root\n");
    await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ packages: ["jq"] }),
      stateDir: await tempDir(),
      trustPem,
    });

    expect(fake.builds.at(-1)?.files["trust.pem"]).toBe("corporate root\n");
  });

  it("refuses an extra Dockerfile with a FROM line", async () => {
    const fake = createFakeBackend();
    const dockerfile = await extraDockerfile("RUN true\n  from debian:12 AS other\n");

    await expect(
      ensureLayerImage({
        backend: fake.backend,
        baseImageId: BASE_ID,
        config: configWith({ dockerfile }),
        stateDir: await tempDir(),
      }),
    ).rejects.toThrow(/image\.dockerfile: .* has a FROM line/);
    expect(fake.builds).toEqual([]);
  });

  it("refuses directives that change how the sandbox starts, runs or trusts, naming the directive", async () => {
    const cases = [
      ["COPY --from=builder /x /y", "has a COPY --from instruction"],
      ["add --from=other /x /y", "has a ADD --from instruction"],
      ['ENTRYPOINT ["/bin/sh"]', "has a ENTRYPOINT instruction"],
      ["CMD sleep 1", "has a CMD instruction"],
      ["user root", "has a USER instruction"],
      ["HEALTHCHECK NONE", "has a HEALTHCHECK instruction"],
      ["ONBUILD RUN true", "has a ONBUILD instruction"],
      ['SHELL ["/bin/bash", "-c"]', "has a SHELL instruction"],
      ["STOPSIGNAL SIGKILL", "has a STOPSIGNAL instruction"],
      ["VOLUME /data", "has a VOLUME instruction"],
      ["ENV NODE_OPTIONS=--require=/x.js", "sets NODE_OPTIONS with ENV"],
      ["ENV A=1 \\\n  node_extra_ca_certs=/x.pem", "sets node_extra_ca_certs with ENV"],
      ["ENV PATH /evil:$PATH", "sets PATH with ENV"],
      ["ARG https_proxy=http://x", "sets https_proxy with ARG"],
      ["ARG SSL_CERT_FILE", "sets SSL_CERT_FILE with ARG"],
      ["ENV HOME=/tmp", "sets HOME with ENV"],
      ["ENV BASH_ENV=/tmp/rc.sh", "sets BASH_ENV with ENV"],
      ["ARG bash_env", "sets bash_env with ARG"],
      ["ENV PI_SANDBOX=0", "sets PI_SANDBOX with ENV"],
      ["ENV CURL_CA_BUNDLE=/x REQUESTS_CA_BUNDLE=/y", "sets CURL_CA_BUNDLE with ENV"],
    ];

    await cases.reduce(async (previous, [line = "", problem = ""]) => {
      await previous;

      const fake = createFakeBackend();
      const dockerfile = await extraDockerfile(`RUN true\n${line}\n`);

      await expect(
        ensureLayerImage({
          backend: fake.backend,
          baseImageId: BASE_ID,
          config: configWith({ dockerfile }),
          stateDir: await tempDir(),
        }),
      ).rejects.toThrow(`image.dockerfile: ${dockerfile} ${problem}`);
      expect(fake.builds).toEqual([]);
    }, Promise.resolve());
  });

  it("accepts plain build steps, a COPY without --from and harmless variables", async () => {
    const fake = createFakeBackend();
    const dockerfile = await extraDockerfile(
      "# USER root in a comment\nRUN echo CMD \\\n && echo USER\nCOPY tool /opt/tool\nENV TOOL_HOME=/opt/tool\nARG VERSION=1\nWORKDIR /opt\n",
    );
    const layer = await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ dockerfile }),
      stateDir: await tempDir(),
    });

    expect(layer.built).toBe(true);
  });

  it("accepts heredoc bodies whose lines look like refused instructions", async () => {
    const fake = createFakeBackend();
    const dockerfile = await extraDockerfile(
      [
        "RUN <<EOF",
        "USER=alice",
        "USER alice",
        "FROM scratch",
        "EOF",
        'COPY <<-"CONF" /etc/tool.conf',
        '\tENTRYPOINT ["/bin/sh"]',
        "\tCONF",
        "RUN cat <<ONE <<'TWO' > /tmp/x",
        "CMD one",
        "ONE",
        "VOLUME /two",
        "TWO",
        "WORKDIR /opt",
        "",
      ].join("\n"),
    );
    const layer = await ensureLayerImage({
      backend: fake.backend,
      baseImageId: BASE_ID,
      config: configWith({ dockerfile }),
      stateDir: await tempDir(),
    });

    expect(layer.built).toBe(true);
  });

  it("checks the instructions after a heredoc ends", async () => {
    const cases = [
      ["RUN <<EOF\necho hi\nEOF\nUSER root", "has a USER instruction"],
      ["RUN <<EOF\necho \\\nEOF\nFROM scratch", "has a FROM line"],
      ["RUN <<-EOF\n\techo hi\n\tEOF\nCMD sleep 1", "has a CMD instruction"],
      ["RUN cat <<A <<B\nA\nB\nENV NODE_OPTIONS=x", "sets NODE_OPTIONS with ENV"],
      ["ENV GREETING=<<EOF\nUSER root", "has a USER instruction"],
    ];

    await cases.reduce(async (previous, [text = "", problem = ""]) => {
      await previous;

      const fake = createFakeBackend();
      const dockerfile = await extraDockerfile(`${text}\n`);

      await expect(
        ensureLayerImage({
          backend: fake.backend,
          baseImageId: BASE_ID,
          config: configWith({ dockerfile }),
          stateDir: await tempDir(),
        }),
      ).rejects.toThrow(`image.dockerfile: ${dockerfile} ${problem}`);
    }, Promise.resolve());
  });

  it("tags the layer by its inputs hash and records it next to the base image", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = configWith({ packages: ["jq"] });
    const base = await ensureBuiltImage({
      backend: fake.backend,
      config,
      versions: { pi: "1.5.0", extensions: { kind: "none" } },
      stateDir,
    });
    const layer = await ensureLayerImage({ backend: fake.backend, baseImageId: base.id, config, stateDir });
    const record = JSON.parse(await readFile(join(stateDir, "image.json"), "utf8"));

    expect(layer.built).toBe(true);
    expect(layer.tag).toMatch(/^pi-sandbox-layer:[0-9a-f]{12}$/);
    expect(fake.builds.at(-1)?.tag).toBe(layer.tag);
    expect(record).toMatchObject({
      id: base.id,
      layer: { tag: layer.tag, id: layer.id, digest: layer.digest },
    });
    expect((await readdir(stateDir)).sort()).toEqual(["image.json"]);
  });

  it("reuses the recorded layer while its inputs hold and rebuilds when a key or the base changes", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = configWith({ packages: ["jq"] });
    const base = await ensureBuiltImage({
      backend: fake.backend,
      config,
      versions: { pi: "1.5.0", extensions: { kind: "none" } },
      stateDir,
    });
    const ensure = (baseImageId: string, image: Partial<ImageConfig>) =>
      ensureLayerImage({ backend: fake.backend, baseImageId, config: configWith(image), stateDir });
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
