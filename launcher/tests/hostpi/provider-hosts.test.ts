import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type BundledPi, locateBundledPi, readProviderHosts } from "../../hostpi/index.ts";
import { createProcessRunner, launcherRoot, stateLayout } from "../../shared/index.ts";
import { createScriptedRunner } from "../support/fake-runner.ts";
import { tempDir, writeText } from "./fixtures.ts";

const SAMPLE = join(import.meta.dirname, "provider-hosts-sample.json");

const PI: BundledPi = {
  command: [process.execPath, "/opt/pi/cli.js"],
  version: "1.5.0",
  packageDir: "/opt/pi",
};

const SCRIPT = join(launcherRoot(), "hostpi", "provider-hosts.mjs");

const sampleRunner = async () => {
  const stdout = await readFile(SAMPLE, "utf8");

  return createScriptedRunner([{ argv: [process.execPath, SCRIPT, PI.packageDir], result: { stdout } }]);
};

describe("readProviderHosts", () => {
  it("runs the bundled script, returns its table and caches it per pi version", async () => {
    const stateDir = await tempDir("provider-hosts");
    const fake = await sampleRunner();
    const first = await readProviderHosts({ stateDir, runner: fake.runner, pi: PI });
    const second = await readProviderHosts({
      stateDir,
      runner: fake.runner,
      pi: PI,
    });
    const cached = JSON.parse(await readFile(stateLayout(stateDir).providerHosts("1.5.0"), "utf8"));

    expect(first.notices).toEqual([]);
    expect(first.hosts).toEqual(JSON.parse(await readFile(SAMPLE, "utf8")));
    expect(second.hosts).toEqual(first.hosts);
    expect(cached).toEqual(first.hosts);
    expect(fake.calls).toHaveLength(1);
  });

  it("returns an empty table with a notice when the script fails or prints something else", async () => {
    const stateDir = await tempDir("provider-hosts");
    const failing = createScriptedRunner([
      { argv: [process.execPath], result: { code: 1, stderr: "boom\n" } },
    ]);
    const garbled = createScriptedRunner([
      { argv: [process.execPath], result: { stdout: '{"x":{"hosts":"no"}}' } },
    ]);
    const failed = await readProviderHosts({
      stateDir,
      runner: failing.runner,
      pi: PI,
    });
    const unreadable = await readProviderHosts({
      stateDir,
      runner: garbled.runner,
      pi: PI,
    });

    expect(failed).toEqual({ hosts: {}, notices: [expect.stringContaining("boom")] });
    expect(unreadable.hosts).toEqual({});
    expect(unreadable.notices).toHaveLength(1);
  });

  it("ignores a broken cache file and runs the script again", async () => {
    const stateDir = await tempDir("provider-hosts");
    const fake = await sampleRunner();

    await writeText(stateLayout(stateDir).providerHosts("1.5.0"), "not json");

    const result = await readProviderHosts({
      stateDir,
      runner: fake.runner,
      pi: PI,
    });

    expect(Object.keys(result.hosts)).toHaveLength(3);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("provider-hosts.mjs", () => {
  it("prints a table of host lists and API key variables from the installed pi, whatever the environment", async () => {
    const piDir = resolve(launcherRoot(), "..", "node_modules", "@earendil-works", "pi-coding-agent");
    const result = await createProcessRunner().run(process.execPath, [SCRIPT, piDir]);
    const table = JSON.parse(result.stdout) as Record<string, { hosts: unknown; envVars?: unknown }>;
    const entries = Object.values(table);

    expect(result.code).toBe(0);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => Array.isArray(entry.envVars) && entry.envVars.length > 0)).toBe(true);
    entries.forEach((entry) => {
      expect(["hosts", "envVars"]).toEqual(expect.arrayContaining(Object.keys(entry)));
      (Array.isArray(entry.envVars) ? entry.envVars : []).forEach((name) => {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      });
      expect(Array.isArray(entry.hosts)).toBe(true);
      (entry.hosts as unknown[]).forEach((host) => {
        expect(host).toMatch(/^[a-z0-9.-]+$/);
      });
    });
    expect(entries.some((entry) => (entry.hosts as unknown[]).length > 0)).toBe(true);
  });

  it("exits non-zero when no pi is found", async () => {
    const dir = await tempDir("provider-hosts-empty");
    const result = await createProcessRunner().run(process.execPath, [SCRIPT, dir]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("provider host lookups stay inside their install", () => {
  it("gives up with a notice when the script does not answer within 30 s", async () => {
    const stateDir = await tempDir("provider-hosts");
    const fake = createScriptedRunner([{ argv: [process.execPath], result: { code: 124, timedOut: true } }]);
    const result = await readProviderHosts({ stateDir, runner: fake.runner, pi: PI });

    expect(result).toEqual({
      hosts: {},
      notices: [
        "provider host table unavailable (no answer within 30 s); built-in providers get no credential rules",
      ],
    });
    expect(fake.calls[0]?.options.timeoutMs).toBe(30_000);
  });

  it("does not take a pi-ai from above the pi install", async () => {
    const dir = await tempDir("provider-hosts-above");

    await writeText(join(dir, "node_modules", "@earendil-works", "pi-ai", "package.json"), "{}");

    const result = await createProcessRunner().run(process.execPath, [SCRIPT, join(dir, "loose", "pi")]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("looks up to the workspace root of a pi checkout without node_modules above it", async () => {
    const dir = await tempDir("provider-hosts-workspace");

    await writeText(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));

    await writeText(join(dir, "node_modules", "@earendil-works", "pi-ai", "package.json"), "{}");

    const result = await createProcessRunner().run(process.execPath, [
      SCRIPT,
      join(dir, "packages", "coding-agent"),
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no ./providers/* export");
  });

  it("finds the bundled pi only inside the launcher's package", async () => {
    const dir = await tempDir("bundled-pi");
    const manifest = JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.0.0",
      bin: { pi: "cli.js" },
    });

    await writeText(
      join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
      manifest,
    );

    expect(await locateBundledPi(join(dir, "app", "launcher"))).toBeUndefined();

    await writeText(
      join(dir, "app", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
      manifest,
    );

    expect((await locateBundledPi(join(dir, "app", "launcher")))?.packageDir).toBe(
      join(dir, "app", "node_modules", "@earendil-works", "pi-coding-agent"),
    );
  });
});
