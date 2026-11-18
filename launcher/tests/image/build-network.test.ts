import { describe, expect, it } from "vitest";
import { ensureBuiltImage } from "../../image/build.ts";
import { ensureSandboxImage } from "../../image/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir as sharedTempDir } from "../support/temp-dir.ts";

const versions = { pi: "1.5.0" };

const tempDir = () => sharedTempDir("network");

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

describe("image build network", () => {
  it("takes the proxy from the launcher env", async () => {
    const recording = recordingBackend();

    await ensureBuiltImage({
      backend: recording.backend,
      config: sandboxConfig(),
      versions,
      stateDir: await tempDir(),
      env: { https_proxy: "http://proxy.corp.example:8080", NO_PROXY: "internal.example" },
    });

    expect(recording.buildArgs[0]).toEqual({
      HTTP_PROXY: "http://proxy.corp.example:8080",
      http_proxy: "http://proxy.corp.example:8080",
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      https_proxy: "http://proxy.corp.example:8080",
      NO_PROXY: "internal.example",
      no_proxy: "internal.example",
      PI_VERSION: "1.5.0",
    });
  });

  it.each([
    ["http://127.0.0.1:3128", "http://host.lima.internal:3128"],
    ["http://localhost:3128/", "http://host.lima.internal:3128"],
    ["http://[::1]:3128", "http://host.lima.internal:3128"],
    ["http://proxy.corp.example", "http://proxy.corp.example:80"],
  ])(
    "gives the build the runtime's parent proxy %s, a loopback one pointed at the host",
    async (local, reachable) => {
      const recording = recordingBackend();

      await ensureBuiltImage({
        backend: recording.backend,
        config: sandboxConfig(),
        versions,
        stateDir: await tempDir(),
        env: { HTTPS_PROXY: local, HTTP_PROXY: "http://other.corp.example:8080" },
      });

      expect(recording.buildArgs[0]).toEqual({
        HTTPS_PROXY: reachable,
        https_proxy: reachable,
        HTTP_PROXY: reachable,
        http_proxy: reachable,
        PI_VERSION: "1.5.0",
      });
    },
  );

  it.each([
    [{ HTTPS_PROXY: "127.0.0.1:3128" }],
    [{ HTTPS_PROXY: "socks5://127.0.0.1:1080" }],
    [{ HTTP_PROXY: "http://dev:hunter2@proxy.corp.example:8080" }],
  ])("builds without a proxy where the runtime uses none: %o", async (env) => {
    const recording = recordingBackend();

    await ensureBuiltImage({
      backend: recording.backend,
      config: sandboxConfig(),
      versions,
      stateDir: await tempDir(),
      env,
    });

    expect(recording.buildArgs[0]).toEqual({ PI_VERSION: "1.5.0" });
  });

  it("uses the lower-case https_proxy when HTTPS_PROXY is empty, as the runtime does", async () => {
    const recording = recordingBackend();

    await ensureBuiltImage({
      backend: recording.backend,
      config: sandboxConfig(),
      versions,
      stateDir: await tempDir(),
      env: { HTTPS_PROXY: "", https_proxy: "http://127.0.0.1:3128" },
    });

    expect(recording.buildArgs[0]).toMatchObject({ HTTPS_PROXY: "http://host.lima.internal:3128" });
  });

  it("sends no proxy build args without a parent proxy", async () => {
    const recording = recordingBackend();

    await ensureBuiltImage({
      backend: recording.backend,
      config: sandboxConfig(),
      versions,
      stateDir: await tempDir(),
      env: {},
    });

    expect(recording.buildArgs).toEqual([{ PI_VERSION: "1.5.0" }]);
  });

  it("refuses credentials in the env proxy URL without echoing them", async () => {
    const recording = recordingBackend();
    const failure = ensureBuiltImage({
      backend: recording.backend,
      config: sandboxConfig(),
      versions,
      stateDir: await tempDir(),
      env: { HTTPS_PROXY: "http://dev:hunter2@proxy.corp.example:8080" },
    });

    await expect(failure).rejects.toThrow(/parent proxy needs credentials/);
    await expect(failure).rejects.not.toThrow(/hunter2/);
    await expect(failure).rejects.toMatchObject({
      hint: "build on a network that needs no proxy credentials; a prebuilt image (image.reference and image.digest) avoids the build only when image.packages, image.npmGlobal and image.dockerfile are unset",
    });
  });

  it("never refuses for credentials when the image is pinned and pulled", async () => {
    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const fake = createFakeBackend({ registry: { [reference]: "sha256:pinned" } });
    const base = sandboxConfig();
    const config = { ...base, image: { reference, digest: "sha256:pinned" } };
    const result = await ensureSandboxImage({
      backend: fake.backend,
      config,
      stateDir: await tempDir(),
      versions: async () => versions,
      env: { HTTPS_PROXY: "http://dev:hunter2@proxy.corp.example:8080" },
    });

    expect(result.digest).toBe("sha256:pinned");
    expect(fake.builds).toEqual([]);
  });
});
