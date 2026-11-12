import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_TAG, ensureBuiltImage, prepareBuildContext, pullPinnedImage } from "../../image/build.ts";
import { recordedImage } from "../../image/index.ts";
import { LauncherError } from "../../shared/index.ts";
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

    await prepareBuildContext(dir);

    expect((await readdir(dir)).sort()).toEqual([
      "Dockerfile",
      "bash-env.sh",
      "entrypoint.sh",
      "proxy-ca.pem",
      "trust.pem",
    ]);
    expect(await readFile(join(dir, "trust.pem"), "utf8")).toBe("");
    expect(await readFile(join(dir, "entrypoint.sh"), "utf8")).toContain("sleep infinity");
    expect(await readFile(join(dir, "bash-env.sh"), "utf8")).toContain("command_not_found_handle");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toContain(
      "BASH_ENV=/usr/local/lib/pi-sandbox/bash-env.sh",
    );
  });

  it("sources the bash hint from the first line of the system bashrc", async () => {
    const dir = await tempDir();

    await prepareBuildContext(dir);

    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toContain(
      "sed -i '1i . /usr/local/lib/pi-sandbox/bash-env.sh' /etc/bash.bashrc",
    );
  });

  it("copies the trust bundle into the context", async () => {
    const dir = await tempDir();
    const trust = join(await tempDir(), "trust.pem");

    await writeFile(trust, "-----BEGIN CERTIFICATE-----\n");
    await prepareBuildContext(dir, { trustPem: trust });

    expect(await readFile(join(dir, "trust.pem"), "utf8")).toBe("-----BEGIN CERTIFICATE-----\n");
  });

  it("copies the proxy CA into the context and keeps it in the system store after the build", async () => {
    const dir = await tempDir();
    const ca = join(await tempDir(), "ca-cert.pem");

    await writeFile(ca, "PROXY CA\n");
    await prepareBuildContext(dir, { proxyCaPem: ca });

    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");

    expect(await readFile(join(dir, "proxy-ca.pem"), "utf8")).toBe("PROXY CA\n");
    expect(dockerfile).toContain("/usr/local/share/ca-certificates/pi-sandbox-proxy.crt");
    expect(dockerfile).toMatch(/update-ca-certificates --fresh/);
  });

  it("installs the base tools and a pi-sandbox command that points back to the host", async () => {
    const dir = await tempDir();

    await prepareBuildContext(dir);

    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");
    const packages =
      /apt-get install -y --no-install-recommends ([^\\\n]+)/.exec(dockerfile)?.[1]?.trim().split(" ") ?? [];

    expect(packages.sort()).toEqual([
      "ca-certificates",
      "fd-find",
      "git",
      "less",
      "ncurses-term",
      "openssh-client",
      "procps",
      "ripgrep",
      "socat",
    ]);
    expect(dockerfile).not.toContain("glab");
    expect(dockerfile).toContain(
      "pi sandbox commands run on the host; ask the user to run pi sandbox $* there",
    );
    expect(dockerfile).toContain("exit 2");
  });

  it("installs the trust bundle for the build only and wires the self-update command", async () => {
    const dir = await tempDir();

    await prepareBuildContext(dir);

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

  it("declares the pi version without a default right before the pi install, so a pi update reuses the earlier layers", async () => {
    const dir = await tempDir();

    await prepareBuildContext(dir);

    const steps = (await readFile(join(dir, "Dockerfile"), "utf8")).split(/\n\n+/);
    const declared = steps.indexOf("ARG PI_VERSION");

    expect(steps).toContain("FROM node:24-bookworm-slim");
    expect(steps.filter((step) => step.includes("PI_VERSION")).length).toBeGreaterThan(1);
    expect(steps.slice(0, declared).some((step) => step.includes("PI_VERSION"))).toBe(false);
    expect(steps[declared + 1]).toMatch(/^RUN test -n "\$\{PI_VERSION\}"[\s\S]*npm install --global/);
  });
});

describe("ensureBuiltImage", () => {
  it("pullPinnedImage pulls the pinned digest and never builds", async () => {
    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const fake = createFakeBackend({ registry: { [reference]: "sha256:pinned" } });
    const config = sandboxConfig({ image: { reference, digest: "sha256:pinned" } });
    const result = await pullPinnedImage(
      { backend: fake.backend, config, stateDir: await tempDir() },
      reference,
      "sha256:pinned",
    );

    expect(result).toEqual({ reference, digest: "sha256:pinned", id: "sha256:image-pinned", built: false });
    expect(fake.pulls).toEqual([reference]);
    expect(fake.builds).toEqual([]);
  });

  it("refuses a pull whose digest is not the pinned one", async () => {
    const reference = "ghcr.io/zharskiy/pi-sandbox:0.4.0";
    const fake = createFakeBackend();
    const backend = { ...fake.backend, pullImage: async () => ({ id: "sha256:x", digest: "sha256:other" }) };
    const config = sandboxConfig({ image: { reference, digest: "sha256:pinned" } });

    await expect(
      pullPinnedImage({ backend, config, stateDir: await tempDir() }, reference, "sha256:pinned"),
    ).rejects.toThrow("has digest sha256:other, expected sha256:pinned");
  });

  it("builds locally when no digest is pinned, with the pi version as a build argument, and records the digest", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();
    const result = await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    expect(result).toEqual({
      reference: BASE_TAG,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
      built: true,
    });
    expect(fake.builds.map((build) => [build.tag, build.args])).toEqual([
      [BASE_TAG, { PI_VERSION: "1.5.0" }],
    ]);
    expect(Object.keys(fake.builds[0]?.files ?? {}).sort()).toEqual([
      "Dockerfile",
      "bash-env.sh",
      "entrypoint.sh",
      "proxy-ca.pem",
      "trust.pem",
    ]);
    expect(JSON.parse(await readFile(join(stateDir, "image.json"), "utf8"))).toEqual({
      base: {
        digest: "sha256:built-1",
        id: "sha256:image-built-1",
        inputsHash: expect.any(String),
      },
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
      reference: BASE_TAG,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
      built: false,
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

  it("rebuilds when the proxy CA changes", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();
    const proxyCaPem = join(await tempDir(), "ca-cert.pem");

    await writeFile(proxyCaPem, "CA ONE\n");
    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir, proxyCaPem });
    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir, proxyCaPem });

    await writeFile(proxyCaPem, "CA TWO\n");
    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir, proxyCaPem });

    expect(fake.builds).toHaveLength(2);
    expect(fake.builds[1]?.files["proxy-ca.pem"]).toBe("CA TWO\n");
  });

  it("refuses a pi version that is not a plain version string before it builds", async () => {
    const fake = createFakeBackend();

    await expect(
      ensureBuiltImage({
        backend: fake.backend,
        config: sandboxConfig(),
        versions: { pi: "1.5.0; rm -rf /" },
        stateDir: await tempDir(),
      }),
    ).rejects.toThrow(/invalid pi version/);
    expect(fake.builds).toEqual([]);
  });

  it("hints that the host pi is not published when npm has no such pi version", async () => {
    const fake = createFakeBackend();
    const npmFailure = [
      "engine: The command '/bin/sh -c npm install' returned a non-zero code: 1",
      "  npm error code ETARGET",
      "  npm error notarget No matching version found for @earendil-works/pi-coding-agent@9.9.9-dev.",
    ].join("\n");
    const backend = {
      ...fake.backend,
      buildImage: async () => Promise.reject(new LauncherError(npmFailure)),
    };
    const failure = await ensureBuiltImage({
      backend,
      config: sandboxConfig(),
      versions: { pi: "9.9.9-dev" },
      stateDir: await tempDir(),
    }).then(
      () => undefined,
      (error: LauncherError) => error,
    );

    expect(failure?.message).toBe(npmFailure);
    expect(failure?.hint).toBe(
      "the host pi is version 9.9.9-dev, which the npm registry does not have; install a published pi on the host",
    );
  });

  it("keeps the hint of a build failure that is not about the pi version", async () => {
    const fake = createFakeBackend();
    const backend = {
      ...fake.backend,
      buildImage: async () =>
        Promise.reject(
          new LauncherError("engine: npm error 404 Not Found - GET https://registry.npmjs.org/x", "own"),
        ),
    };
    const failure = await ensureBuiltImage({
      backend,
      config: sandboxConfig(),
      versions,
      stateDir: await tempDir(),
    }).then(
      () => undefined,
      (error: LauncherError) => error,
    );

    expect(failure?.hint).toBe("own");
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
  it("returns the recorded base image only while the config asks for it", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();

    expect(await recordedImage(stateDir, config)).toBeUndefined();

    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    expect(await recordedImage(stateDir, config)).toMatchObject({
      reference: BASE_TAG,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
    });
    const reference = "registry.corp.example/pi:1";
    const pinnedConfig = sandboxConfig({ image: { reference, digest: "sha256:pinned" } });

    expect(await recordedImage(stateDir, pinnedConfig)).toBeUndefined();

    const fakeRegistry = createFakeBackend({ registry: { [reference]: "sha256:pinned" } });

    await pullPinnedImage(
      { backend: fakeRegistry.backend, config: pinnedConfig, stateDir },
      reference,
      "sha256:pinned",
    );

    expect(await recordedImage(stateDir, pinnedConfig)).toMatchObject({ reference, digest: "sha256:pinned" });
    expect(await recordedImage(stateDir, config)).toBeUndefined();
  });
});
