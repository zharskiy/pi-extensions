import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliDeps, run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness, writeManagedPi, writePathPi } from "./harness.ts";

type ProxyRequest = Parameters<CliDeps["proxy"]["ensure"]>[0];

const BUNDLED_ENTRY = "/fake/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

const launchHarness = async (options: { bundledPi?: null } = {}) => {
  const fake = createFakeBackend();
  const requests: ProxyRequest[] = [];
  const harness = await createHarness({
    backend: () => fake.backend,
    ...options,
    proxy: {
      ensure: async (request) => {
        requests.push(request);

        return { pid: 4242, port: 3128, policyHash: "policy", token: "token-1" };
      },
    },
  });

  return { fake, harness, requests };
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
    expect(requests[0]?.piVersion).toBe("1.6.0");
    expect(providerScriptCall(harness)?.args[1]).toBe(managed.packageDir);
    expect(fake.builds[0]?.files.Dockerfile).toContain("ARG PI_VERSION=1.6.0");
  });

  it("rebuilds the image with the new host pi once the repository's container has stopped", async () => {
    const { fake, harness } = await launchHarness();

    expect(await run([], harness.deps)).toBe(0);

    await writeManagedPi(harness.hostAgentDir, "1.6.0");

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.builds.map((build) => build.files.Dockerfile?.match(/^ARG PI_VERSION=(.*)$/m)?.[1])).toEqual([
      await testedPiVersion(),
      "1.6.0",
    ]);
    expect(harness.stderr()).not.toContain("the sandbox image has pi");
  });

  it("records the pi version of an image whose record names none once the container has stopped", async () => {
    const { fake, harness } = await launchHarness();

    expect(await run([], harness.deps)).toBe(0);

    const recordFile = join(harness.stateDir, "image.json");
    const { pi: _recorded, ...record } = JSON.parse(await readFile(recordFile, "utf8"));

    await writeFile(recordFile, JSON.stringify(record));

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.builds).toHaveLength(1);
    expect(JSON.parse(await readFile(recordFile, "utf8")).pi).toBe(await testedPiVersion());
  });

  it("keeps the image of a running container after a host pi update, says so, and still derives provider rules", async () => {
    const { fake, harness } = await launchHarness();

    expect(await run([], harness.deps)).toBe(0);

    fake.containers.forEach((entry, id) => {
      fake.containers.set(id, { ...entry, summary: { ...entry.summary, state: "running" } });
    });

    await writeManagedPi(harness.hostAgentDir, "1.6.0");

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.builds).toHaveLength(1);
    expect(harness.stderr()).toContain(
      `pi-sandbox: the sandbox image has pi ${await testedPiVersion()}, the host pi 1.6.0; the image is rebuilt after every session in this repository exits\n`,
    );
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
    expect(requests[0]?.piVersion).not.toBe("1.7.0");
  });

  it("gives the proxy no pi when there is neither a managed install nor the launcher's own pi", async () => {
    const { harness, requests } = await launchHarness({ bundledPi: null });
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run([], harness.deps)).toBe(0);
    expect(requests[0]?.piCommand).toEqual([]);
    expect(requests[0]?.piVersion).toBeUndefined();
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

  it("ignores a PATH pi inside the repository or on a relative PATH entry and runs the launcher's pi", async () => {
    const harness = await createHarness();
    const planted = await writePathPi(join(harness.repoRoot, "tools"), "1.7.0");

    harness.deps.env.PATH = `${planted.bin}:tools/bin`;

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
