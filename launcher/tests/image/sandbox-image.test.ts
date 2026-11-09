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
});
