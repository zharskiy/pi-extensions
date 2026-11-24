import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathsOf } from "../../cli/deps.ts";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { repoHash, writeRepoRecord } from "../../shared/index.ts";
import {
  createFakeBackend,
  createHarness,
  holdLaunch,
  noHostPiLine,
  writeManagedPi,
  writeNpmPi,
  writePathPi,
} from "./harness.ts";

const launchHarness = async (options: { hostPi?: false } = {}) => {
  const fake = createFakeBackend();
  const harness = await createHarness({ backend: () => fake.backend, ...options });

  return { fake, harness, requests: harness.proxyInputs };
};

const interactiveCall = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.find((call) => call.interactive);

const npmCalls = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.filter((call) => call.file.endsWith("/npm"));

const providerScriptCall = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.find((call) => (call.args[0] ?? "").endsWith("provider-hosts.mjs"));

describe("the host pi of host jobs", () => {
  it("gives the proxy pi's managed install with node and builds the image with its version", async () => {
    const { fake, harness, requests } = await launchHarness();
    const managed = await writeManagedPi(harness.hostAgentDir, "1.6.0");
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([process.execPath, managed.entry]);
    expect(providerScriptCall(harness)?.args[1]).toBe(managed.packageDir);
    expect(fake.builds[0]?.args?.PI_VERSION).toBe("1.6.0");
  });

  it("rebuilds the image when the host pi version changes, also while another launch of the repository runs, and still derives provider rules", async () => {
    const { fake, harness } = await launchHarness();

    await holdLaunch(harness);

    expect(await run([], harness.deps)).toBe(0);

    await writeManagedPi(harness.hostAgentDir, "99.0.0");

    expect(await run([], harness.deps)).toBe(0);
    const baseBuilds = fake.builds.filter((build) => build.tag === "pi-sandbox-base:local");

    expect(baseBuilds.map((build) => build.args?.PI_VERSION)).toEqual([await testedPiVersion(), "99.0.0"]);
    expect(harness.stderr()).not.toContain("provider host table unavailable");
  });

  it("finds no host pi when the managed marker or current-version is not valid", async () => {
    const marked = await launchHarness({ hostPi: false });
    const escaping = await launchHarness({ hostPi: false });

    await writeManagedPi(marked.harness.hostAgentDir, "1.6.0", { marker: { kind: "something-else" } });

    await writeManagedPi(escaping.harness.hostAgentDir, "1.6.0", { release: "../1.6.0" });

    expect(await run([], marked.harness.deps)).toBe(0);
    expect(await run([], escaping.harness.deps)).toBe(0);
    expect(marked.requests[0]?.piCommand).toEqual([]);
    expect(escaping.requests[0]?.piCommand).toEqual([]);
    expect(marked.harness.stderr()).toContain(`pinata: ${noHostPiLine(marked.harness.hostAgentDir)}\n`);
  });

  it("gives the proxy no pi without a managed install, even with a pi on PATH", async () => {
    const { harness, requests } = await launchHarness({ hostPi: false });
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([]);
    expect(providerScriptCall(harness)).toBeUndefined();
    expect(harness.stderr()).toContain(`pinata: ${noHostPiLine(harness.hostAgentDir)}\n`);
  });
});

describe("pi --no-sandbox", () => {
  it("never runs a PATH pi, inside the repository or not, and runs the managed wrapper", async () => {
    const harness = await createHarness();
    const planted = await writePathPi(join(harness.repoRoot, "tools"), "1.7.0");
    const brew = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = `${brew.bin}:${planted.bin}:tools/bin`;

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);
    expect(interactiveCall(harness)?.file).toBe(join(harness.hostAgentDir, "bin", "pi"));
    expect(interactiveCall(harness)?.args).toEqual(["-p", "hi"]);
  });

  it("prints the missing-pi line without a managed install, even with a pi on PATH", async () => {
    const harness = await createHarness({ hostPi: false });
    const brew = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = brew.bin;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(interactiveCall(harness)).toBeUndefined();
    expect(harness.stderr()).toBe(`pinata: --no-sandbox: ${noHostPiLine(harness.hostAgentDir)}\n`);
  });
});

describe("pi installed with npm install -g", () => {
  it("is the host pi without a managed install, asked of npm from the home folder", async () => {
    const { fake, harness, requests } = await launchHarness({ hostPi: false });
    const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0");

    harness.deps.env.PATH = npmPi.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([process.execPath, npmPi.entry]);
    expect(providerScriptCall(harness)?.args[1]).toBe(npmPi.packageDir);
    expect(fake.builds[0]?.args?.PI_VERSION).toBe("1.6.0");
    expect(npmCalls(harness)[0]?.args).toEqual(["root", "--global"]);
    expect(npmCalls(harness)[0]?.options.cwd).toBe(harness.deps.home);
  });

  it("asks npm with npm's own folder first on PATH, so the node beside it runs it", async () => {
    const harness = await createHarness({ hostPi: false });
    const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0");
    const other = join(harness.root, "other", "bin");

    harness.deps.env.PATH = `${other}:${npmPi.bin}`;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(npmCalls(harness)[0]?.options.env?.PATH).toBe(`${npmPi.bin}:${other}:${npmPi.bin}`);
  });

  it("runs the package's pi entry with the launcher's node for --no-sandbox, not a pi link on PATH", async () => {
    const harness = await createHarness({ hostPi: false });
    const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0");

    harness.deps.env.PATH = npmPi.bin;

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);
    expect(interactiveCall(harness)?.file).toBe(process.execPath);
    expect(interactiveCall(harness)?.args).toEqual([npmPi.entry, "-p", "hi"]);
  });

  it("gives way to the managed install, and npm is not asked", async () => {
    const harness = await createHarness();
    const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.7.0");

    harness.deps.env.PATH = npmPi.bin;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(interactiveCall(harness)?.file).toBe(join(harness.hostAgentDir, "bin", "pi"));
    expect(npmCalls(harness)).toEqual([]);
  });

  it("is not used when its package.json has no valid version or a pi entry outside the package", async () => {
    const manifests = [
      { version: "1.6.0; rm -rf /", bin: { pi: "dist/cli.js" } },
      { version: 1, bin: { pi: "dist/cli.js" } },
      { version: "1.6.0" },
      { version: "1.6.0", bin: { pi: "../../../bin/npm" } },
    ];
    const outcomes = await Promise.all(
      manifests.map(async (manifest) => {
        const harness = await createHarness({ hostPi: false });
        const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0", { manifest });

        harness.deps.env.PATH = npmPi.bin;

        return { code: await run(["--no-sandbox"], harness.deps), spawned: interactiveCall(harness) };
      }),
    );

    expect(outcomes).toEqual(manifests.map(() => ({ code: 1, spawned: undefined })));
  });

  it("is not used when npm fails, times out, or prints a relative or non-node_modules root", async () => {
    const npmAnswers = (result: { code: number; timedOut?: true }) => (call: { file: string }) =>
      call.file.endsWith("/npm") ? result : undefined;
    const cases = [
      { respond: npmAnswers({ code: 3 }) },
      { respond: npmAnswers({ code: 124, timedOut: true }) },
      { reportedRoot: join("lib", "node_modules") },
      { reportedRoot: "lib" },
    ];
    const outcomes = await Promise.all(
      cases.map(async ({ respond, reportedRoot }) => {
        const harness = await createHarness({ hostPi: false, respond });
        const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0", { reportedRoot });

        harness.deps.env.PATH = npmPi.bin;

        return {
          code: await run(["--no-sandbox"], harness.deps),
          asked: npmCalls(harness).length,
          stderr: harness.stderr() === `pinata: --no-sandbox: ${noHostPiLine(harness.hostAgentDir)}\n`,
        };
      }),
    );

    expect(outcomes).toEqual(cases.map(() => ({ code: 1, asked: 1, stderr: true })));
  });

  it("never asks an npm found inside the repository, nor takes a global root inside it", async () => {
    const planted = await createHarness({ hostPi: false });
    const inRepo = await writeNpmPi(join(planted.repoRoot, "tools"), "1.6.0");
    const steered = await createHarness({ hostPi: false });
    const repoPrefix = join(steered.repoRoot, "prefix");
    const inside = await writeNpmPi(repoPrefix, "1.6.0");
    const outside = await writeNpmPi(join(steered.root, "nvm"), "1.6.0", { reportedRoot: inside.root });

    planted.deps.env.PATH = inRepo.bin;

    steered.deps.env.PATH = outside.bin;

    expect(await run(["--no-sandbox"], planted.deps)).toBe(1);
    expect(await run(["--no-sandbox"], steered.deps)).toBe(1);
    expect(npmCalls(planted)).toEqual([]);
    expect(npmCalls(steered)).toHaveLength(1);
    expect(interactiveCall(steered)).toBeUndefined();
  });

  it("is found when npm and the package lie in a git checkout no sandbox has run in, as Homebrew and nvm install them", async () => {
    const harness = await createHarness({ hostPi: false });
    const checkout = join(harness.root, "homebrew");
    const npmPi = await writeNpmPi(checkout, "1.6.0");

    await mkdir(join(checkout, ".git"), { recursive: true });

    harness.deps.env.PATH = npmPi.bin;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(npmCalls(harness)).toHaveLength(1);
    expect(interactiveCall(harness)?.args[0]).toBe(npmPi.entry);
  });

  it("never asks an npm that lies in a folder a sandbox has run in, nor takes a global root inside it", async () => {
    const planted = await createHarness({ hostPi: false });
    const plantedRoot = join(planted.root, "sandboxed");
    const inSandboxed = await writeNpmPi(join(plantedRoot, "prefix"), "1.6.0");
    const steered = await createHarness({ hostPi: false });
    const steeredRoot = join(steered.root, "sandboxed");
    const inside = await writeNpmPi(join(steeredRoot, "prefix"), "1.6.0");
    const outside = await writeNpmPi(join(steered.root, "nvm"), "1.6.0", { reportedRoot: inside.root });

    await writeRepoRecord(pathsOf(planted.deps).stateDir, repoHash(plantedRoot), plantedRoot);

    await writeRepoRecord(pathsOf(steered.deps).stateDir, repoHash(steeredRoot), steeredRoot);

    planted.deps.env.PATH = inSandboxed.bin;

    steered.deps.env.PATH = outside.bin;

    expect(await run(["--no-sandbox"], planted.deps)).toBe(1);
    expect(await run(["--no-sandbox"], steered.deps)).toBe(1);
    expect(npmCalls(planted)).toEqual([]);
    expect(npmCalls(steered)).toHaveLength(1);
    expect(interactiveCall(planted)).toBeUndefined();
    expect(interactiveCall(steered)).toBeUndefined();
  });

  it("is not used when the global package is a link out of the global root, even into a checkout no sandbox has run in", async () => {
    const harness = await createHarness({ hostPi: false });
    const checkout = join(harness.root, "pi-checkout");
    const linked = await writeNpmPi(join(checkout, "prefix"), "1.6.0");
    const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0");

    await mkdir(join(checkout, ".git"), { recursive: true });

    await rm(npmPi.packageDir, { recursive: true });

    await symlink(linked.packageDir, npmPi.packageDir);

    harness.deps.env.PATH = npmPi.bin;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(npmCalls(harness)).toHaveLength(1);
    expect(interactiveCall(harness)).toBeUndefined();
  });

  it("is not used when the pi entry is a link out of the package", async () => {
    const harness = await createHarness({ hostPi: false });
    const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0");
    const elsewhere = await writeNpmPi(join(harness.root, "elsewhere"), "1.6.0");

    await rm(npmPi.entry);

    await symlink(elsewhere.entry, npmPi.entry);

    harness.deps.env.PATH = npmPi.bin;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(npmCalls(harness)).toHaveLength(1);
    expect(interactiveCall(harness)).toBeUndefined();
  });

  it("is not used when the global package is a link into the repository, as npm link leaves it", async () => {
    const harness = await createHarness({ hostPi: false });
    const linked = await writeNpmPi(join(harness.repoRoot, "prefix"), "1.6.0");
    const npmPi = await writeNpmPi(join(harness.root, "nvm"), "1.6.0");

    await rm(npmPi.packageDir, { recursive: true });

    await symlink(linked.packageDir, npmPi.packageDir);

    harness.deps.env.PATH = npmPi.bin;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(npmCalls(harness)).toHaveLength(1);
    expect(interactiveCall(harness)).toBeUndefined();
  });

  it("is not looked for from a home folder that is itself a git repository, which lies outside the workspace root", async () => {
    const harness = await createHarness({ hostPi: false });
    const npmPi = await writeNpmPi(join(harness.deps.home, ".nvm", "node"), "1.6.0");

    await mkdir(join(harness.deps.home, ".git"), { recursive: true });

    harness.deps.env.PATH = npmPi.bin;

    harness.deps.cwd = harness.deps.home;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pinata: ${harness.deps.home} is outside the workspace root`);
    expect(interactiveCall(harness)).toBeUndefined();
  });

  it("is not found through a pi in a project's node_modules", async () => {
    const harness = await createHarness({ hostPi: false });
    const local = join(harness.repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

    await mkdir(join(local, "dist"), { recursive: true });

    await writeFile(
      join(local, "package.json"),
      JSON.stringify({ version: "1.6.0", bin: { pi: "dist/cli.js" } }),
    );

    await writeFile(join(local, "dist", "cli.js"), "");

    await mkdir(join(harness.repoRoot, "node_modules", ".bin"), { recursive: true });

    await symlink(join(local, "dist", "cli.js"), join(harness.repoRoot, "node_modules", ".bin", "pi"));

    harness.deps.env.PATH = join(harness.repoRoot, "node_modules", ".bin");

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(interactiveCall(harness)).toBeUndefined();
    expect(npmCalls(harness)).toEqual([]);
  });
});
