import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { createFakeBackend, createHarness, holdLaunch, writeManagedPi, writePathPi } from "./harness.ts";

const BUNDLED_ENTRY = "/fake/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const launchHarness = async (options: { bundledPi?: null } = {}) => {
  const fake = createFakeBackend();
  const harness = await createHarness({ backend: () => fake.backend, ...options });

  return { fake, harness, requests: harness.proxyInputs };
};

const interactiveCall = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.find((call) => call.interactive);

const providerScriptCall = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.find((call) => (call.args[0] ?? "").endsWith("provider-hosts.mjs"));

describe("the host pi of host jobs", () => {
  it("runs pi's managed install with node for host jobs and builds the image with its version", async () => {
    const { fake, harness, requests } = await launchHarness();
    const managed = await writeManagedPi(harness.hostAgentDir, "1.6.0");
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([process.execPath, managed.entry]);
    expect(providerScriptCall(harness)?.args[1]).toBe(managed.packageDir);
    expect(fake.builds[0]?.args?.PI_VERSION).toBe("1.6.0");
  });

  it("rebuilds the image when the host pi version changes", async () => {
    const { fake, harness } = await launchHarness();

    expect(await run([], harness.deps)).toBe(0);

    await writeManagedPi(harness.hostAgentDir, "1.6.0");

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.builds.map((build) => build.args?.PI_VERSION)).toEqual([await testedPiVersion(), "1.6.0"]);
  });

  it("rebuilds for a host pi update while another launch of the repository runs, and still derives provider rules", async () => {
    const { fake, harness } = await launchHarness();

    await holdLaunch(harness);

    expect(await run([], harness.deps)).toBe(0);

    await writeManagedPi(harness.hostAgentDir, "1.6.0");

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.builds.map((build) => build.args?.PI_VERSION)).toEqual([await testedPiVersion(), "1.6.0"]);
    expect(harness.stderr()).not.toContain("provider host table unavailable");
  });

  it("falls back to the launcher's own pi when the managed marker or current-version is not valid", async () => {
    const marked = await launchHarness();
    const escaping = await launchHarness();

    await writeManagedPi(marked.harness.hostAgentDir, "1.6.0", { marker: { kind: "something-else" } });

    await writeManagedPi(escaping.harness.hostAgentDir, "1.6.0", { release: "../1.6.0" });

    expect(await run([], marked.harness.deps)).toBe(0);
    expect(await run([], escaping.harness.deps)).toBe(0);
    expect(marked.requests[0]?.piCommand).toEqual([process.execPath, BUNDLED_ENTRY]);
    expect(escaping.requests[0]?.piCommand).toEqual([process.execPath, BUNDLED_ENTRY]);
  });

  it("never hands a pi found on PATH to the proxy", async () => {
    const { harness, requests } = await launchHarness();
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([process.execPath, BUNDLED_ENTRY]);
  });

  it("gives the proxy no pi when there is neither a managed install nor the launcher's own pi", async () => {
    const { harness, requests } = await launchHarness({ bundledPi: null });
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([]);
  });
});

describe("pi --no-sandbox", () => {
  it("runs the managed wrapper when PATH holds only the launcher", async () => {
    const harness = await createHarness();
    const managed = await writeManagedPi(harness.hostAgentDir, "1.6.0");

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);
    expect(interactiveCall(harness)?.file).toBe(managed.wrapper);
    expect(interactiveCall(harness)?.args).toEqual(["-p", "hi"]);
  });

  it("never runs a PATH pi, inside the repository or not, and runs the launcher's pi", async () => {
    const harness = await createHarness();
    const planted = await writePathPi(join(harness.repoRoot, "tools"), "1.7.0");
    const brew = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = `${brew.bin}:${planted.bin}:tools/bin`;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(interactiveCall(harness)?.file).toBe(process.execPath);
    expect(interactiveCall(harness)?.args).toEqual([BUNDLED_ENTRY]);
  });

  it("says there is no pi on the host when nothing is found", async () => {
    const harness = await createHarness({ bundledPi: null });

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("--no-sandbox: no pi on the host");
  });
});

describe("the bundled pi", () => {
  it("is not used for host jobs when its package lies inside the repository", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const planted = join(harness.repoRoot, "node_modules", "pi");

    harness.deps.bundledPi = async () => ({
      command: [process.execPath, join(planted, "dist", "cli.js")],
      version: await testedPiVersion(),
      packageDir: planted,
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(providerScriptCall(harness)).toBeUndefined();
    expect(harness.proxyInputs.at(-1)?.piCommand).toEqual([]);
    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("pi-sandbox: --no-sandbox: no pi on the host");
  });
});
