import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBuiltImage, prepareBuildContext } from "../../image/build.ts";
import { recordedImage } from "../../image/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const versions = { pi: "1.5.0" };

const dirs: string[] = [];

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-image-"));

  dirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareBuildContext", () => {
  it("writes the Dockerfile, the entrypoint, the bash hint and an empty trust file, and no pi auth or models", async () => {
    const dir = await tempDir();

    await prepareBuildContext(versions, dir);

    expect((await readdir(dir)).sort()).toEqual(["Dockerfile", "bash-env.sh", "entrypoint.sh", "trust.pem"]);
    expect(await readFile(join(dir, "trust.pem"), "utf8")).toBe("");
    expect(await readFile(join(dir, "entrypoint.sh"), "utf8")).toContain("sleep infinity");
    expect(await readFile(join(dir, "bash-env.sh"), "utf8")).toContain("command_not_found_handle");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toContain(
      "BASH_ENV=/usr/local/lib/pi-sandbox/bash-env.sh",
    );
  });

  it("sources the bash hint from the first line of the system bashrc", async () => {
    const dir = await tempDir();

    await prepareBuildContext(versions, dir);

    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toContain(
      "sed -i '1i . /usr/local/lib/pi-sandbox/bash-env.sh' /etc/bash.bashrc",
    );
  });

  it("copies the trust bundle into the context", async () => {
    const dir = await tempDir();
    const trust = join(await tempDir(), "trust.pem");

    await writeFile(trust, "-----BEGIN CERTIFICATE-----\n");
    await prepareBuildContext(versions, dir, trust);

    expect(await readFile(join(dir, "trust.pem"), "utf8")).toBe("-----BEGIN CERTIFICATE-----\n");
  });

  it("installs the trust bundle for the build only and wires the self-update command", async () => {
    const dir = await tempDir();

    await prepareBuildContext(versions, dir);

    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("/usr/local/share/ca-certificates/");
    expect(dockerfile).toContain("update-ca-certificates");
    expect(dockerfile).toMatch(/^ARG NODE_EXTRA_CA_CERTS=/m);
    expect(dockerfile).not.toMatch(/^ENV[^\n]*NODE_EXTRA_CA_CERTS/m);
    expect(dockerfile).not.toContain("PI_OFFLINE");
    expect(dockerfile).not.toMatch(/auth\.json|models\.json/);
    expect(dockerfile).toContain("PI_SELF_UPDATE_COMMAND=/usr/local/bin/pi-sandbox-self-update");
    expect(dockerfile).toContain("is managed by the sandbox and follows the launcher");
  });

  it("pins the pi version as a Dockerfile default", async () => {
    const dir = await tempDir();

    await prepareBuildContext(versions, dir);

    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim$/m);
    expect(dockerfile).toMatch(/^ARG PI_VERSION=1\.5\.0$/m);
  });

  it("refuses a version that is not a plain version string", async () => {
    const dir = await tempDir();

    await expect(prepareBuildContext({ ...versions, pi: "1.5.0; rm -rf /" }, dir)).rejects.toThrow(
      /invalid pi version/,
    );
  });
});

describe("ensureBuiltImage", () => {
  it("pulls the pinned digest and never builds", async () => {
    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const fake = createFakeBackend({ registry: { [reference]: "sha256:pinned" } });
    const config = sandboxConfig({ image: { reference, digest: "sha256:pinned" } });
    const result = await ensureBuiltImage({
      backend: fake.backend,
      config,
      versions,
      stateDir: await tempDir(),
    });

    expect(result).toEqual({ reference, digest: "sha256:pinned", id: "sha256:image-pinned", built: false });
    expect(fake.pulls).toEqual([reference]);
    expect(fake.builds).toEqual([]);
  });

  it("refuses a pull whose digest is not the pinned one", async () => {
    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const fake = createFakeBackend();
    const backend = { ...fake.backend, pullImage: async () => ({ id: "sha256:x", digest: "sha256:other" }) };
    const config = sandboxConfig({ image: { reference, digest: "sha256:pinned" } });

    await expect(ensureBuiltImage({ backend, config, versions, stateDir: await tempDir() })).rejects.toThrow(
      "has digest sha256:other, expected sha256:pinned",
    );
  });

  it("builds locally when no digest is pinned and records the digest and the pi version", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();
    const result = await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    expect(result).toEqual({
      reference: config.image.reference,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
      built: true,
      pi: versions.pi,
    });
    expect(fake.builds.map((build) => build.tag)).toEqual([config.image.reference]);
    expect(Object.keys(fake.builds[0]?.files ?? {}).sort()).toEqual([
      "Dockerfile",
      "bash-env.sh",
      "entrypoint.sh",
      "trust.pem",
    ]);
    expect(JSON.parse(await readFile(join(stateDir, "image.json"), "utf8"))).toMatchObject({
      reference: config.image.reference,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
      pi: versions.pi,
    });
    expect((await readdir(stateDir)).sort()).toEqual(["image.json"]);
  });

  it("reuses the recorded build while its inputs are unchanged, whatever the credential rules", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();

    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    const again = await ensureBuiltImage({
      backend: fake.backend,
      config: sandboxConfig({
        credentials: {
          rules: [
            { id: "llm", host: "llm.example.com", placeholder: "pi-sandbox-llm", secret: { env: "LLM_KEY" } },
          ],
          derive: { enabled: true },
        },
      }),
      versions,
      stateDir,
    });

    expect(again).toEqual({
      reference: config.image.reference,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
      built: false,
      pi: versions.pi,
    });
    expect(fake.builds).toHaveLength(1);
  });

  it("rebuilds when the versions change", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();

    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });
    await ensureBuiltImage({
      backend: fake.backend,
      config,
      versions: { ...versions, pi: "1.6.0" },
      stateDir,
    });

    expect(fake.builds).toHaveLength(2);
  });

  it("rebuilds when the recorded image is gone from the engine", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();

    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    fake.localImages.clear();

    const again = await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    expect(again.built).toBe(true);
    expect(fake.builds).toHaveLength(2);
  });
});

describe("recordedImage", () => {
  it("returns the recorded image for the configured reference and pinned digest only", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();

    expect(await recordedImage(stateDir, config)).toBeUndefined();

    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    expect(await recordedImage(stateDir, config)).toMatchObject({
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
    });
    expect(await recordedImage(stateDir, sandboxConfig({ image: { reference: "other:1" } }))).toBeUndefined();
    expect(
      await recordedImage(stateDir, sandboxConfig({ image: { ...config.image, digest: "sha256:pinned" } })),
    ).toBeUndefined();
  });
});
