import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ParentProxy } from "../../config/index.ts";
import { ensureBuiltImage } from "../../image/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const versions = { pi: "1.5.0", extensions: { kind: "none" as const } };

const dirs: string[] = [];

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-network-"));

  dirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const recordingBackend = () => {
  const fake = createFakeBackend();
  const buildArgs: Array<Record<string, string> | undefined> = [];
  const backend = {
    ...fake.backend,
    buildImage: async (contextDir: string, tag: string, args?: Record<string, string>) => {
      buildArgs.push(args);

      return fake.backend.buildImage(contextDir, tag);
    },
  };

  return { backend, buildArgs, fake };
};

const egressWith = (parentProxy: ParentProxy) => {
  const base = sandboxConfig();

  return sandboxConfig({ egress: { ...base.egress, parentProxy } });
};

describe("image build network", () => {
  it("sends a configured parent proxy without credentials as the predefined proxy build args", async () => {
    const recording = recordingBackend();
    const config = egressWith({
      url: "http://proxy.corp.example:3128",
      noProxy: [".corp.example", "localhost"],
    });

    await ensureBuiltImage({ backend: recording.backend, config, versions, stateDir: await tempDir() });

    expect(recording.buildArgs).toEqual([
      {
        HTTP_PROXY: "http://proxy.corp.example:3128",
        http_proxy: "http://proxy.corp.example:3128",
        HTTPS_PROXY: "http://proxy.corp.example:3128",
        https_proxy: "http://proxy.corp.example:3128",
        NO_PROXY: ".corp.example,localhost",
        no_proxy: ".corp.example,localhost",
      },
    ]);
  });

  it("takes the proxy from the launcher env when the parent proxy is env", async () => {
    const recording = recordingBackend();

    await ensureBuiltImage({
      backend: recording.backend,
      config: egressWith("env"),
      versions,
      stateDir: await tempDir(),
      env: { https_proxy: "http://proxy.corp.example:8080", NO_PROXY: "internal.example" },
    });

    expect(recording.buildArgs[0]).toMatchObject({
      HTTP_PROXY: "http://proxy.corp.example:8080",
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "internal.example",
    });
  });

  it("sends no proxy build args without a parent proxy", async () => {
    const recording = recordingBackend();

    await ensureBuiltImage({
      backend: recording.backend,
      config: egressWith("none"),
      versions,
      stateDir: await tempDir(),
      env: { HTTPS_PROXY: "http://proxy.corp.example:8080" },
    });
    await ensureBuiltImage({
      backend: recording.backend,
      config: egressWith("env"),
      versions: { ...versions, pi: "1.6.0" },
      stateDir: await tempDir(),
      env: {},
    });

    expect(recording.buildArgs).toEqual([{}, {}]);
  });

  it("refuses a parent proxy with credentials and leaves no build context behind", async () => {
    const recording = recordingBackend();
    const stateDir = await tempDir();
    const config = egressWith({ url: "http://proxy.corp.example:3128", auth: { env: "PROXY_PASSWORD" } });

    await expect(
      ensureBuiltImage({ backend: recording.backend, config, versions, stateDir }),
    ).rejects.toThrow(/parent proxy needs credentials/);
    expect(recording.buildArgs).toEqual([]);
    expect(await readdir(stateDir)).toEqual([]);
  });

  it("refuses credentials in the env proxy URL without echoing them", async () => {
    const recording = recordingBackend();
    const failure = ensureBuiltImage({
      backend: recording.backend,
      config: egressWith("env"),
      versions,
      stateDir: await tempDir(),
      env: { HTTPS_PROXY: "http://dev:hunter2@proxy.corp.example:8080" },
    });

    await expect(failure).rejects.toThrow(/parent proxy needs credentials/);
    await expect(failure).rejects.not.toThrow(/hunter2/);
  });

  it("never refuses for credentials when the image is pinned and pulled", async () => {
    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const fake = createFakeBackend({ registry: { [reference]: "sha256:pinned" } });
    const base = egressWith({ url: "http://proxy.corp.example:3128", auth: { env: "PROXY_PASSWORD" } });
    const config = { ...base, image: { reference, digest: "sha256:pinned" } };
    const result = await ensureBuiltImage({
      backend: fake.backend,
      config,
      versions,
      stateDir: await tempDir(),
    });

    expect(result.built).toBe(false);
  });
});
