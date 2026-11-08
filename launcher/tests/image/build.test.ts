import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBuiltImage, prepareBuildContext } from "../../image/build.ts";
import { packExtensionsTarball } from "../../image/extensions.ts";
import { recordedImage, resolveExtensionsSource } from "../../image/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createFakeRunner } from "../support/fake-runner.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const versions = { pi: "1.5.0", extensions: { kind: "registry" as const, version: "0.4.0" } };

const gateway = {
  url: "https://gateway.example.com",
  authHeader: "x-api-key",
  placeholder: "pi-sandbox-placeholder",
  providers: [{ id: "gateway", apiKind: "example-messages" }],
};

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
  it("writes the Dockerfile, the entrypoint, the browser shim, the bash hint and an empty trust file, and no pi auth or models", async () => {
    const dir = await tempDir();

    await prepareBuildContext(versions, dir);

    expect((await readdir(dir)).sort()).toEqual([
      "Dockerfile",
      "bash-env.sh",
      "entrypoint.sh",
      "trust.pem",
      "xdg-open.mjs",
    ]);
    expect(await readFile(join(dir, "trust.pem"), "utf8")).toBe("");
    expect(await readFile(join(dir, "entrypoint.sh"), "utf8")).toContain("sleep infinity");
    expect(await readFile(join(dir, "bash-env.sh"), "utf8")).toContain("command_not_found_handle");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toContain(
      "BASH_ENV=/usr/local/lib/pi-sandbox/bash-env.sh",
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

  it("pins the pi and extensions versions as Dockerfile defaults", async () => {
    const dir = await tempDir();

    await prepareBuildContext(versions, dir);

    const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim$/m);
    expect(dockerfile).toMatch(/^ARG PI_VERSION=1\.5\.0$/m);
    expect(dockerfile).toMatch(/^ARG EXTENSIONS_SOURCE=pi-extensions-mz@0\.4\.0$/m);
  });

  it("copies an extensions tarball into the context and installs from it", async () => {
    const dir = await tempDir();
    const tarball = join(await tempDir(), "pi-extensions-mz-0.4.0.tgz");

    await writeFile(tarball, "tarball bytes");
    await prepareBuildContext({ pi: "1.5.0", extensions: { kind: "tarball", path: tarball } }, dir);

    expect(await readFile(join(dir, "pi-extensions.tgz"), "utf8")).toBe("tarball bytes");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toMatch(
      /^ARG EXTENSIONS_SOURCE=pi-extensions\.tgz$/m,
    );
  });

  it("builds without extensions when the source is none", async () => {
    const dir = await tempDir();

    await prepareBuildContext({ pi: "1.5.0", extensions: { kind: "none" } }, dir);

    expect(await readdir(dir)).not.toContain("pi-extensions.tgz");
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toMatch(/^ARG EXTENSIONS_SOURCE=none$/m);
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

  it("builds locally when no digest is pinned and records the digest", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();
    const result = await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    expect(result).toEqual({
      reference: config.image.reference,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
      built: true,
    });
    expect(fake.builds.map((build) => build.tag)).toEqual([config.image.reference]);
    expect(Object.keys(fake.builds[0]?.files ?? {}).sort()).toEqual([
      "Dockerfile",
      "bash-env.sh",
      "entrypoint.sh",
      "trust.pem",
      "xdg-open.mjs",
    ]);
    expect(JSON.parse(await readFile(join(stateDir, "image.json"), "utf8"))).toMatchObject({
      reference: config.image.reference,
      digest: "sha256:built-1",
      id: "sha256:image-built-1",
    });
    expect((await readdir(stateDir)).sort()).toEqual(["image.json"]);
  });

  it("reuses the recorded build while its inputs are unchanged, whatever the gateway", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const config = sandboxConfig();

    await ensureBuiltImage({ backend: fake.backend, config, versions, stateDir });

    const again = await ensureBuiltImage({
      backend: fake.backend,
      config: sandboxConfig({ gateway }),
      versions,
      stateDir,
    });

    expect(again).toEqual({
      reference: config.image.reference,
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

  it("rebuilds when the extensions tarball content changes", async () => {
    const fake = createFakeBackend();
    const stateDir = await tempDir();
    const tarball = join(await tempDir(), "pi-extensions-mz-0.4.0.tgz");
    const tarballVersions = { pi: "1.5.0", extensions: { kind: "tarball" as const, path: tarball } };

    await writeFile(tarball, "first");
    await ensureBuiltImage({
      backend: fake.backend,
      config: sandboxConfig(),
      versions: tarballVersions,
      stateDir,
    });
    await ensureBuiltImage({
      backend: fake.backend,
      config: sandboxConfig(),
      versions: tarballVersions,
      stateDir,
    });
    await writeFile(tarball, "second");
    await ensureBuiltImage({
      backend: fake.backend,
      config: sandboxConfig(),
      versions: tarballVersions,
      stateDir,
    });

    expect(fake.builds).toHaveLength(2);
    expect(fake.builds[1]?.files["pi-extensions.tgz"]).toBe("second");
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

const packingRunner = (code = 0) =>
  createFakeRunner((call) => {
    const outDir = call.args[2] ?? "";

    if (call.file === "git") {
      return { code: 128 };
    }

    if (code === 0) {
      writeFileSync(join(outDir, "pi-extensions-mz-0.4.0.tgz"), "packed");
    }

    return code === 0
      ? { stdout: "> prepack\n> npm run build\npi-extensions-mz-0.4.0.tgz\n" }
      : { code, stderr: "npm error something\nnpm error code E1" };
  });

const packageAt = async (packageDir: string, manifest: Record<string, string>) => {
  await mkdir(join(packageDir, "launcher"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));

  return join(packageDir, "launcher");
};

describe("packExtensionsTarball", () => {
  it("packs the package into the out dir and returns the tarball path", async () => {
    const outDir = join(await tempDir(), "out");
    const { runner, calls } = packingRunner();
    const path = await packExtensionsTarball({ packageDir: "/src/pkg", runner, outDir });

    expect(path).toBe(join(outDir, "pi-extensions-mz-0.4.0.tgz"));
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      ["npm", "pack", "--pack-destination", outDir, "/src/pkg"],
    ]);
  });

  it("reports a failed pack", async () => {
    const { runner } = packingRunner(1);

    await expect(
      packExtensionsTarball({ packageDir: "/src/pkg", runner, outDir: await tempDir() }),
    ).rejects.toThrow(/npm pack \/src\/pkg failed: npm error code E1/);
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

  it("ignores a record from before image ids were recorded", async () => {
    const stateDir = await tempDir();
    const config = sandboxConfig();

    await writeFile(
      join(stateDir, "image.json"),
      JSON.stringify({ reference: config.image.reference, digest: "sha256:old", inputsHash: "x" }),
    );

    expect(await recordedImage(stateDir, config)).toBeUndefined();
  });
});

describe("resolveExtensionsSource", () => {
  const gitRunner = (head: string, status = "") =>
    createFakeRunner((call) => {
      if (call.file === "git") {
        return { stdout: call.args.includes("status") ? status : `${head}\n` };
      }

      writeFileSync(join(call.args[2] ?? "", "pi-extensions-mz-0.4.0.tgz"), "packed");

      return { stdout: "pi-extensions-mz-0.4.0.tgz\n" };
    });

  it("reuses the packed tarball while the version and HEAD are unchanged", async () => {
    const root = await packageAt(join(await tempDir(), "checkout"), {
      name: "pi-extensions-mz",
      version: "0.4.0",
    });
    const stateDir = await tempDir();
    const first = gitRunner("head-one");
    const second = gitRunner("head-one");
    const moved = gitRunner("head-two");

    await resolveExtensionsSource({ launcherRoot: root, runner: first.runner, stateDir });
    await resolveExtensionsSource({ launcherRoot: root, runner: second.runner, stateDir });
    await resolveExtensionsSource({ launcherRoot: root, runner: moved.runner, stateDir });

    const packs = (calls: typeof first.calls) => calls.filter((call) => call.file === "npm").length;

    expect([packs(first.calls), packs(second.calls), packs(moved.calls)]).toEqual([1, 0, 1]);
  });

  it("packs again on every launch while the checkout has uncommitted changes, and after them", async () => {
    const root = await packageAt(join(await tempDir(), "checkout"), {
      name: "pi-extensions-mz",
      version: "0.4.0",
    });
    const stateDir = await tempDir();
    const clean = gitRunner("head-one");
    const dirty = gitRunner("head-one", " M extensions/a/index.ts\0");
    const again = gitRunner("head-one", " M extensions/a/index.ts\0");
    const committed = gitRunner("head-one");
    const runs = [clean, dirty, again, committed];

    await runs.reduce(
      (previous, { runner }) =>
        previous.then(() => resolveExtensionsSource({ launcherRoot: root, runner, stateDir })),
      Promise.resolve<unknown>(undefined),
    );

    expect(runs.map(({ calls }) => calls.filter((call) => call.file === "npm").length)).toEqual([1, 1, 1, 1]);
  });

  it("packs a checkout of this package into a tarball", async () => {
    const root = await packageAt(join(await tempDir(), "checkout"), {
      name: "pi-extensions-mz",
      version: "0.4.0",
    });
    const stateDir = await tempDir();
    const { runner } = packingRunner();

    expect(await resolveExtensionsSource({ launcherRoot: root, runner, stateDir })).toEqual({
      kind: "tarball",
      path: join(stateDir, "pack", "pi-extensions-mz-0.4.0.tgz"),
    });
  });

  it("uses the registry version for an installed copy", async () => {
    const installed = join(await tempDir(), "lib", "node_modules", "pi-extensions-mz");
    const root = await packageAt(installed, { name: "pi-extensions-mz", version: "0.4.1" });
    const { runner, calls } = packingRunner();

    expect(await resolveExtensionsSource({ launcherRoot: root, runner, stateDir: await tempDir() })).toEqual({
      kind: "registry",
      version: "0.4.1",
    });
    expect(calls).toEqual([]);
  });

  it("refuses a folder that is not this package", async () => {
    const root = await packageAt(join(await tempDir(), "other"), {
      name: "something-else",
      version: "1.0.0",
    });
    const { runner } = packingRunner();

    await expect(
      resolveExtensionsSource({ launcherRoot: root, runner, stateDir: await tempDir() }),
    ).rejects.toThrow(/not the pi-extensions-mz package/);
  });
});
