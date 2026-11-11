import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import {
  createFakeBackend,
  createHarness,
  holdLaunch,
  noHostPiLine,
  writeManagedPi,
  writePathPi,
} from "./harness.ts";

const writeLauncherPi = async (harness: Awaited<ReturnType<typeof createHarness>>) => {
  const packageDir = join(harness.repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

  await mkdir(join(packageDir, "dist"), { recursive: true });

  await writeFile(join(packageDir, "dist", "cli.js"), "");

  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.7.0", bin: { pi: "dist/cli.js" } }),
  );
};

const launchHarness = async (options: { hostPi?: false } = {}) => {
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

  it("finds no host pi when the managed marker or current-version is not valid", async () => {
    const marked = await launchHarness({ hostPi: false });
    const escaping = await launchHarness({ hostPi: false });

    await writeManagedPi(marked.harness.hostAgentDir, "1.6.0", { marker: { kind: "something-else" } });

    await writeManagedPi(escaping.harness.hostAgentDir, "1.6.0", { release: "../1.6.0" });

    expect(await run([], marked.harness.deps)).toBe(0);
    expect(await run([], escaping.harness.deps)).toBe(0);
    expect(marked.requests[0]?.piCommand).toEqual([]);
    expect(escaping.requests[0]?.piCommand).toEqual([]);
    expect(marked.harness.stderr()).toContain(`pi-sandbox: ${noHostPiLine(marked.harness.hostAgentDir)}\n`);
  });

  it("gives the proxy no pi without a managed install, even with a pi on PATH or in node_modules", async () => {
    const { harness, requests } = await launchHarness({ hostPi: false });
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    await writeLauncherPi(harness);

    harness.deps.env.PATH = onPath.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([]);
    expect(providerScriptCall(harness)).toBeUndefined();
    expect(harness.stderr()).toContain(`pi-sandbox: ${noHostPiLine(harness.hostAgentDir)}\n`);
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

  it("never runs a PATH pi, inside the repository or not, and runs the managed wrapper", async () => {
    const harness = await createHarness();
    const planted = await writePathPi(join(harness.repoRoot, "tools"), "1.7.0");
    const brew = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = `${brew.bin}:${planted.bin}:tools/bin`;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(interactiveCall(harness)?.file).toBe(join(harness.hostAgentDir, "bin", "pi"));
    expect(interactiveCall(harness)?.args).toEqual([]);
  });

  it("prints the missing-pi line without a managed install, even with a pi on PATH", async () => {
    const harness = await createHarness({ hostPi: false });
    const brew = await writePathPi(join(harness.root, "brew"), "1.7.0");

    await writeLauncherPi(harness);

    harness.deps.env.PATH = brew.bin;

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(interactiveCall(harness)).toBeUndefined();
    expect(harness.stderr()).toBe(`pi-sandbox: --no-sandbox: ${noHostPiLine(harness.hostAgentDir)}\n`);
  });
});
