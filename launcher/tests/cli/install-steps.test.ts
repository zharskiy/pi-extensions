import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkInstall, installStatusLine } from "../../cli/commands/doctor-install.ts";
import { run } from "../../cli/index.ts";
import { readReceipt } from "../../cli/install-receipt.ts";
import { launcherVersion, testedPiVersion } from "../../cli/versions.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createHarness, holdLaunch } from "./harness.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

const MARKER = "pi-sandbox-org-marker-7c41";

const ORG_CONFIG = {
  credentials: {
    rules: [{ id: "llm", host: "llm.corp.test", placeholder: MARKER, secret: { env: "LLM_KEY" } }],
  },
};

const textOf = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const writeOrg = async (harness: Harness, value: unknown = ORG_CONFIG) => {
  const file = join(harness.root, "org", "config.json");

  await mkdir(join(harness.root, "org"), { recursive: true });

  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));

  return file;
};

const proposedOf = (harness: Harness) => harness.userConfigFile.replace(/\.json$/, ".proposed.json");

const receiptFile = (harness: Harness) => join(harness.stateDir, "install.json");

const writeReceiptJson = async (harness: Harness, value: unknown) => {
  await writeFile(receiptFile(harness), typeof value === "string" ? value : JSON.stringify(value));
};

const seed = async (harness: Harness, args: string[]) => {
  const code = await run(["__seed-config", ...args], harness.deps);

  return { code, stdout: harness.stdout(), stderr: harness.stderr() };
};

const recordWritten = async (harness: Harness, from: string, text: string) => {
  await writeReceiptJson(harness, {
    schemaVersion: 1,
    config: { from, sha256: sha256Hex(text), outcome: "created" },
  });
};

describe("pi-sandbox __seed-config", () => {
  it("creates an absent config.json with 0600 from the organisation file, and prints the outcome and its sha256", async () => {
    const harness = await createHarness();
    const from = await writeOrg(harness);
    const result = await seed(harness, ["--from", from, "--"]);

    expect(result.code).toBe(0);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(textOf(ORG_CONFIG));
    expect(await modeOf(harness.userConfigFile)).toBe(0o600);
    expect(result.stdout).toBe(`created ${sha256Hex(textOf(ORG_CONFIG))}\n`);
    expect(result.stdout).not.toContain(MARKER);
  });

  it("puts the roots given in place of the file's workspaceRoots and prints them, the existing ones first", async () => {
    const harness = await createHarness();
    const from = await writeOrg(harness, { ...ORG_CONFIG, workspaceRoots: { roots: ["~/elsewhere"] } });
    const result = await seed(harness, ["--from", from, "--", join(harness.root, "gone"), harness.repoRoot]);
    const written = {
      ...ORG_CONFIG,
      workspaceRoots: { roots: [join(harness.root, "gone"), harness.repoRoot] },
    };

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual(written);
    expect(result.stdout).toBe(
      `created ${sha256Hex(textOf(written))}\n${harness.repoRoot}\n${join(harness.root, "gone")}\n`,
    );
  });

  it("writes an update through a symlinked config.json, which stays a symlink", async () => {
    const harness = await createHarness();
    const previous = textOf({ env: { allow: ["FOO"] } });
    const from = await writeOrg(harness);
    const target = join(harness.root, "dotfiles", "pi-sandbox.json");

    await mkdir(join(harness.root, "dotfiles"), { recursive: true });

    await mkdir(join(harness.userConfigFile, ".."), { recursive: true });

    await writeFile(target, previous);

    await symlink(target, harness.userConfigFile);

    await recordWritten(harness, from, previous);

    const result = await seed(harness, ["--from", from, "--"]);

    expect(result.code).toBe(0);
    expect((await lstat(harness.userConfigFile)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(textOf(ORG_CONFIG));
  });

  it("leaves an equal config.json alone and deletes a stale proposed file", async () => {
    const harness = await createHarness();
    const from = await writeOrg(harness);

    await harness.writeJson(harness.userConfigFile, ORG_CONFIG);

    await writeFile(proposedOf(harness), "{}\n");

    const result = await seed(harness, ["--from", from, "--"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`unchanged ${sha256Hex(JSON.stringify(ORG_CONFIG))}\n`);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(JSON.stringify(ORG_CONFIG));
    expect(await exists(proposedOf(harness))).toBe(false);
  });

  it("updates a config.json the installer wrote and nobody edited", async () => {
    const harness = await createHarness();
    const previous = textOf({ env: { allow: ["FOO"] } });
    const from = await writeOrg(harness);

    await mkdir(join(harness.userConfigFile, ".."), { recursive: true });

    await writeFile(harness.userConfigFile, previous);

    await recordWritten(harness, from, previous);

    await writeFile(proposedOf(harness), "{}\n");

    const result = await seed(harness, ["--from", from, "--"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`updated ${sha256Hex(textOf(ORG_CONFIG))}\n`);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(textOf(ORG_CONFIG));
    expect(await modeOf(harness.userConfigFile)).toBe(0o600);
    expect(await exists(proposedOf(harness))).toBe(false);
  });

  it("keeps an edited config.json, writes the candidate beside it with 0600 and keeps the recorded sha256", async () => {
    const harness = await createHarness();
    const written = textOf({ env: { allow: ["FOO"] } });
    const edited = textOf({ env: { allow: ["FOO", "BAR"] } });
    const from = await writeOrg(harness);

    await mkdir(join(harness.userConfigFile, ".."), { recursive: true });

    await writeFile(harness.userConfigFile, edited);

    await recordWritten(harness, from, written);

    const result = await seed(harness, ["--from", from, "--"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`kept ${sha256Hex(written)}\n`);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(edited);
    expect(await readFile(proposedOf(harness), "utf8")).toBe(textOf(ORG_CONFIG));
    expect(await modeOf(proposedOf(harness))).toBe(0o600);
  });

  it("prints no sha256 when it keeps a config.json the installer never wrote", async () => {
    const harness = await createHarness();
    const from = await writeOrg(harness);

    await harness.writeJson(harness.userConfigFile, { env: { allow: ["MINE"] } });

    expect((await seed(harness, ["--from", from, "--"])).stdout).toBe("kept -\n");
  });

  it("replaces an edited config.json with --conflict replace and keeps one 0600 backup", async () => {
    const harness = await createHarness();
    const edited = JSON.stringify({ env: { allow: ["MINE"] } });
    const from = await writeOrg(harness);

    await harness.writeJson(harness.userConfigFile, { env: { allow: ["OLD"] } });

    await writeFile(`${harness.userConfigFile}.bak`, "older backup\n");

    await writeFile(harness.userConfigFile, edited);

    await writeFile(proposedOf(harness), "{}\n");

    const result = await seed(harness, ["--from", from, "--conflict", "replace", "--"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`replaced ${sha256Hex(textOf(ORG_CONFIG))}\n`);
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(textOf(ORG_CONFIG));
    expect(await readFile(`${harness.userConfigFile}.bak`, "utf8")).toBe(edited);
    expect(await modeOf(`${harness.userConfigFile}.bak`)).toBe(0o600);
    expect(await exists(proposedOf(harness))).toBe(false);
  });

  it("refuses an edited config.json with --conflict fail with 78 and writes nothing", async () => {
    const harness = await createHarness();
    const edited = JSON.stringify({ env: { allow: ["MINE"] } });
    const from = await writeOrg(harness);

    await harness.writeJson(harness.userConfigFile, { env: { allow: ["MINE"] } });

    const result = await seed(harness, ["--from", from, "--conflict", "fail", "--"]);

    expect(result.code).toBe(78);
    expect(result.stderr).toContain(`${harness.userConfigFile} was edited since the installer last wrote it`);
    expect(result.stdout).toBe("");
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(edited);
    expect(await exists(proposedOf(harness))).toBe(false);
    expect(await exists(`${harness.userConfigFile}.bak`)).toBe(false);
  });

  it("rejects an unreadable, non-JSON or invalid organisation file with 78 without printing its contents", async () => {
    const harness = await createHarness();
    const missing = await seed(harness, ["--from", join(harness.root, "nope.json"), "--"]);
    const broken = await writeOrg(harness, `{ "placeholder": "${MARKER}", `);
    const notJson = await run(["__seed-config", "--from", broken, "--"], harness.deps);
    const invalid = await writeOrg(harness, { ...ORG_CONFIG, egress: { blocked: [MARKER] } });
    const badKey = await run(["__seed-config", "--from", invalid, "--"], harness.deps);

    expect(missing.code).toBe(78);
    expect(notJson).toBe(78);
    expect(badKey).toBe(78);
    expect(harness.stderr()).toContain(`cannot read the --config file ${join(harness.root, "nope.json")}`);
    expect(harness.stderr()).toContain(`the --config file ${broken} is not a JSON object`);
    expect(harness.stderr()).toContain("egress.blocked is not a known key");
    expect(harness.stderr()).not.toContain(MARKER);
    expect(harness.stdout()).toBe("");
    expect(await exists(harness.userConfigFile)).toBe(false);
  });

  it("rejects a root workspaceRoots refuses with 78 and writes nothing", async () => {
    const harness = await createHarness();
    const from = await writeOrg(harness);
    const result = await seed(harness, ["--from", from, "--", "~/.ssh"]);

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("workspaceRoots.roots: ~/.ssh overlaps ~/.ssh");
    expect(await exists(harness.userConfigFile)).toBe(false);
  });

  it("plans with --check and writes nothing, for a config file and for roots only", async () => {
    const harness = await createHarness();
    const from = await writeOrg(harness);

    expect(await run(["__seed-config", "--check", "--from", from, "--"], harness.deps)).toBe(0);
    expect(await run(["__seed-config", "--check", "--", harness.repoRoot], harness.deps)).toBe(0);
    expect(await run(["__seed-config", "--check", "--"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(`created ${sha256Hex(textOf(ORG_CONFIG))}\ncreated -\nnone -\n`);
    expect(await exists(harness.userConfigFile)).toBe(false);
    expect(await exists(proposedOf(harness))).toBe(false);
  });

  it("rejects with --check an existing config.json the plan would keep but the launcher cannot load", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { egress: { blocked: [] } });

    expect(await run(["__seed-config", "--check", "--"], harness.deps)).toBe(78);
    expect(harness.stderr()).toContain("egress.blocked is not a known key");
  });

  it("rejects with --check roots that differ from an existing config", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { workspaceRoots: { roots: ["~/elsewhere"] } });

    expect(await run(["__seed-config", "--check", "--", harness.repoRoot], harness.deps)).toBe(78);
    expect(harness.stderr()).toContain(`${harness.userConfigFile} exists; set workspaceRoots in it`);
  });
});

describe("pi-sandbox __busy", () => {
  it("exits 75 while a launch is live and 0 otherwise", async () => {
    const harness = await createHarness();

    expect(await run(["__busy"], harness.deps)).toBe(0);

    await holdLaunch(harness);

    expect(await run(["__busy"], harness.deps)).toBe(75);
    expect(harness.stderr()).toContain("pi sessions");
  });
});

const piCalls = (harness: Harness) =>
  harness.calls
    .filter((call) => call.interactive && call.file === join(harness.hostAgentDir, "bin", "pi"))
    .map((call) => call.args);

describe("pi-sandbox __extensions", () => {
  it("removes the other sources of this package from host pi, then installs the source, through the managed pi with the agent dir set", async () => {
    const harness = await createHarness();

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: [
        "npm:@zharskiy/pinata@0.3.0",
        "git:github.com/zharskiy/pi-extensions@v0.3.0",
        "https://github.com/zharskiy/pi-extensions.git",
        { source: "git:example.com/fork/pi-ext@v1" },
        "npm:other-package@1.0.0",
      ],
    });

    await writeReceiptJson(harness, {
      schemaVersion: 1,
      extensions: { source: "git:example.com/fork/pi-ext@v1" },
    });

    expect(await run(["__extensions", "install", "npm:@zharskiy/pinata@0.4.0"], harness.deps)).toBe(0);
    expect(piCalls(harness)).toEqual([
      ["remove", "git:github.com/zharskiy/pi-extensions@v0.3.0"],
      ["remove", "https://github.com/zharskiy/pi-extensions.git"],
      ["remove", "git:example.com/fork/pi-ext@v1"],
      ["install", "npm:@zharskiy/pinata@0.4.0"],
    ]);

    const call = harness.calls.find((entry) => entry.interactive);

    expect(call?.options.env?.PI_CODING_AGENT_DIR).toBe(harness.hostAgentDir);
    expect(call?.options.cwd).not.toBe(harness.cwd);
  });

  it("removes the pre-release npm name and local copies of this package, and leaves other local paths alone", async () => {
    const harness = await createHarness();
    const copy = join(harness.root, "checkout");
    const legacyCopy = join(harness.root, "legacy");
    const other = join(harness.root, "other");

    await harness.writeJson(join(copy, "package.json"), { name: "@zharskiy/pinata" });

    await harness.writeJson(join(legacyCopy, "package.json"), { name: "pi-extensions-mz" });

    await harness.writeJson(join(other, "package.json"), { name: "someone-else" });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: ["npm:pi-extensions-mz@0.3.0", copy, legacyCopy, other, join(harness.root, "missing")],
    });

    expect(await run(["__extensions", "install", "npm:@zharskiy/pinata@0.6.0"], harness.deps)).toBe(0);
    expect(piCalls(harness)).toEqual([
      ["remove", "npm:pi-extensions-mz@0.3.0"],
      ["remove", copy],
      ["remove", legacyCopy],
      ["install", "npm:@zharskiy/pinata@0.6.0"],
    ]);
  });

  it("resolves a relative local entry against the host agent dir, as pi does for user settings", async () => {
    const harness = await createHarness();
    const copy = join(harness.hostAgentDir, "..", "pinata-checkout");

    await harness.writeJson(join(copy, "package.json"), { name: "@zharskiy/pinata" });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: ["../pinata-checkout"],
    });

    expect(await run(["__extensions", "install", "npm:@zharskiy/pinata@0.6.0"], harness.deps)).toBe(0);
    expect(piCalls(harness)[0]).toEqual(["remove", join(harness.hostAgentDir, "..", "pinata-checkout")]);
  });

  it("runs pi install and pi remove with stdin ignored, so an unattended install never waits", async () => {
    const harness = await createHarness();

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: ["npm:pi-extensions-mz@0.3.0"],
    });

    expect(await run(["__extensions", "install", "npm:@zharskiy/pinata@0.6.0"], harness.deps)).toBe(0);
    expect(harness.calls.filter((call) => call.interactive).map((call) => call.options.stdin)).toEqual([
      "ignore",
      "ignore",
    ]);
  });

  it("installs a git source over an npm entry of this package", async () => {
    const harness = await createHarness();

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: ["npm:@zharskiy/pinata@0.3.0"],
    });

    expect(
      await run(["__extensions", "install", "git:github.com/zharskiy/pi-extensions@v0.4.0"], harness.deps),
    ).toBe(0);
    expect(piCalls(harness)).toEqual([
      ["remove", "npm:@zharskiy/pinata@0.3.0"],
      ["install", "git:github.com/zharskiy/pi-extensions@v0.4.0"],
    ]);
  });

  it("carries pi's changelog marker from the replaced source to the new one after pi install", async () => {
    const harness = await createHarness();
    const keyOf = (source: string) => JSON.stringify({ source, scope: "user" });
    const settings = join(harness.hostAgentDir, "settings.json");

    await harness.writeJson(settings, {
      packages: ["npm:@zharskiy/pinata@0.5.0"],
      extensionChangelogVersions: { [keyOf("npm:@zharskiy/pinata@0.5.0")]: "0.5.0" },
    });

    expect(await run(["__extensions", "install", "npm:@zharskiy/pinata@0.6.0"], harness.deps)).toBe(0);
    expect(piCalls(harness)).toEqual([["install", "npm:@zharskiy/pinata@0.6.0"]]);
    expect(JSON.parse(await readFile(settings, "utf8")).extensionChangelogVersions).toEqual({
      [keyOf("npm:@zharskiy/pinata@0.6.0")]: "0.5.0",
    });
  });

  it("exits 70 naming the pi command when pi install fails", async () => {
    const harness = await createHarness({
      respond: (call) => (call.interactive && call.args[0] === "install" ? { code: 3 } : undefined),
    });

    expect(await run(["__extensions", "install", "npm:@zharskiy/pinata@0.4.0"], harness.deps)).toBe(70);
    expect(harness.stderr()).toBe("pi-sandbox: pi install npm:@zharskiy/pinata@0.4.0 failed (exit 3)\n");
  });

  it("refuses a source that is not a pi package source and runs no pi", async () => {
    const harness = await createHarness();

    expect(await run(["__extensions", "install", "./local/path"], harness.deps)).toBe(1);
    expect(piCalls(harness)).toEqual([]);
  });

  it("removes the receipt's source, and nothing without a receipt", async () => {
    const harness = await createHarness();

    expect(await run(["__extensions", "remove"], harness.deps)).toBe(0);
    expect(piCalls(harness)).toEqual([]);

    await writeReceiptJson(harness, {
      schemaVersion: 1,
      extensions: { source: "npm:@zharskiy/pinata@0.4.0" },
    });

    expect(await run(["__extensions", "remove"], harness.deps)).toBe(0);
    expect(piCalls(harness)).toEqual([["remove", "npm:@zharskiy/pinata@0.4.0"]]);
  });
});

const receiptJson = async (harness: Harness) =>
  JSON.parse(await readFile(receiptFile(harness), "utf8")) as Record<string, unknown>;

const RECEIPT_KEYS = [
  "bootstrap",
  "config",
  "extensions",
  "installedAt",
  "installerApi",
  "package",
  "pi",
  "schemaVersion",
  "smoke",
];

describe("pi-sandbox __receipt", () => {
  it("writes the receipt with 0600, the bootstrap from the environment and host pi's version", async () => {
    const harness = await createHarness({
      env: { PI_INSTALL_BOOTSTRAP_API: "1", PI_INSTALL_BOOTSTRAP_VERSION: "0.4.0" },
    });
    const sha = sha256Hex("text\n");
    const args = [
      "--mode",
      "global",
      "--spec",
      "@zharskiy/pinata@0.4.0",
      "--smoke",
      "passed",
      "--extensions",
      "npm:@zharskiy/pinata@0.4.0",
      "--config-from",
      "org.json",
      "--config-outcome",
      "created",
      "--config-sha256",
      sha,
    ];

    expect(await run(["__receipt", ...args], harness.deps)).toBe(0);
    expect(await modeOf(receiptFile(harness))).toBe(0o600);
    expect(await receiptJson(harness)).toEqual({
      schemaVersion: 1,
      installerApi: 1,
      installedAt: new Date(1_700_000_000_000).toISOString(),
      package: {
        name: "@zharskiy/pinata",
        version: await launcherVersion(),
        spec: "@zharskiy/pinata@0.4.0",
        mode: "global",
      },
      bootstrap: { api: 1, version: "0.4.0" },
      pi: { version: await testedPiVersion() },
      extensions: { source: "npm:@zharskiy/pinata@0.4.0" },
      config: { from: join(harness.cwd, "org.json"), sha256: sha, outcome: "created" },
      smoke: "passed",
    });
  });

  it("carries the previous extensions and config forward and records null for what never happened", async () => {
    const harness = await createHarness({ hostPi: false });
    const config = { from: "/org.json", sha256: sha256Hex("a"), outcome: "kept" };

    expect(
      await run(["__receipt", "--mode", "checkout", "--spec", "-", "--smoke", "skipped"], harness.deps),
    ).toBe(0);

    const first = await receiptJson(harness);

    expect(Object.keys(first).sort()).toEqual(RECEIPT_KEYS);
    expect(first).toMatchObject({ bootstrap: null, extensions: null, config: null, pi: { version: null } });
    expect(first.package).toMatchObject({ spec: null, mode: "checkout" });

    await writeReceiptJson(harness, {
      ...first,
      extensions: { source: "npm:@zharskiy/pinata@0.4.0" },
      config,
    });

    expect(
      await run(["__receipt", "--mode", "checkout", "--spec", "-", "--smoke", "failed"], harness.deps),
    ).toBe(0);
    expect(await receiptJson(harness)).toMatchObject({
      extensions: { source: "npm:@zharskiy/pinata@0.4.0" },
      config,
      smoke: "failed",
    });
  });

  it("records a config.json written from --root with the sha256 of the file, so a later --config may update it", async () => {
    const harness = await createHarness();
    const written = textOf({ workspaceRoots: { roots: [harness.repoRoot] } });

    await mkdir(join(harness.userConfigFile, ".."), { recursive: true });

    await writeFile(harness.userConfigFile, written);

    const args = [
      "--mode",
      "global",
      "--smoke",
      "pending",
      "--config-from",
      "--root",
      "--config-outcome",
      "created",
    ];

    expect(await run(["__receipt", ...args], harness.deps)).toBe(0);
    expect((await receiptJson(harness)).config).toEqual({
      from: "--root",
      sha256: sha256Hex(written),
      outcome: "created",
    });
    expect((await receiptJson(harness)).smoke).toBe("pending");

    const from = await writeOrg(harness);
    const result = await seed(harness, ["--from", from, "--"]);

    expect(result.stdout).toBe(`updated ${sha256Hex(textOf(ORG_CONFIG))}\n`);
  });

  it("refuses an unknown mode or smoke result", async () => {
    const harness = await createHarness();

    expect(await run(["__receipt", "--mode", "elsewhere", "--smoke", "passed"], harness.deps)).toBe(1);
    expect(await run(["__receipt", "--mode", "global", "--smoke", "maybe"], harness.deps)).toBe(1);
    expect(await exists(receiptFile(harness))).toBe(false);
  });
});

describe("reading the install receipt", () => {
  it("takes a missing, garbage or newer receipt as no receipt and ignores unknown fields", async () => {
    const harness = await createHarness();

    expect(await readReceipt(harness.stateDir)).toBeUndefined();

    await writeReceiptJson(harness, "{ not json");

    expect(await readReceipt(harness.stateDir)).toBeUndefined();

    await writeReceiptJson(harness, { schemaVersion: 2, package: { version: "9.0.0" } });

    expect(await readReceipt(harness.stateDir)).toBeUndefined();

    await writeReceiptJson(harness, {
      schemaVersion: 1,
      future: { anything: true },
      package: { version: "0.4.0", mode: "global", extra: 1 },
      extensions: "not an object",
      config: { from: "/org.json", sha256: "not hex", outcome: "created" },
    });

    expect(await readReceipt(harness.stateDir)).toEqual({
      version: "0.4.0",
      mode: "global",
      installedAt: undefined,
      smoke: undefined,
      extensions: null,
      config: { from: "/org.json", sha256: null, outcome: "created" },
    });
  });
});

const goodReceipt = async (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  installedAt: "2026-11-17T10:00:00.000Z",
  package: { name: "@zharskiy/pinata", version: await launcherVersion(), spec: null, mode: "checkout" },
  extensions: { source: `npm:@zharskiy/pinata@${await launcherVersion()}` },
  config: { from: "/org.json", sha256: sha256Hex("a"), outcome: "created" },
  smoke: "passed",
  ...extra,
});

describe("the install doctor check and status line", () => {
  it("skips without a receipt", async () => {
    const harness = await createHarness();

    expect(await checkInstall(harness.deps)).toEqual({
      status: "skip",
      detail: "installed without a receipt",
    });
    expect(await installStatusLine(harness.deps)).toBe("install: installed without a receipt");
  });

  it("passes with a receipt that matches the launcher and host pi's packages", async () => {
    const harness = await createHarness();
    const version = await launcherVersion();

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: [`npm:@zharskiy/pinata@${version}`],
    });

    await writeReceiptJson(harness, await goodReceipt());

    expect(await checkInstall(harness.deps)).toMatchObject({
      status: "ok",
      detail: `${version} (checkout), extensions npm:@zharskiy/pinata@${version}, config created`,
    });
    expect(await installStatusLine(harness.deps)).toBe(
      `install: ${version} (checkout), extensions npm:@zharskiy/pinata@${version}, config created, at 2026-11-17T10:00:00.000Z, smoke passed`,
    );
  });

  it("warns about another recorded version, a missing or other extensions version and a proposed config, with the fixes", async () => {
    const harness = await createHarness();
    const version = await launcherVersion();

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: ["npm:@zharskiy/pinata@0.0.1"],
    });

    await writeReceiptJson(
      harness,
      await goodReceipt({
        package: { version: "0.0.1", mode: "global" },
        extensions: { source: "npm:@zharskiy/pinata@0.0.1" },
      }),
    );

    await harness.writeJson(proposedOf(harness), {});

    const result = await checkInstall(harness.deps);

    expect(result.status).toBe("warn");
    expect(result.detail).toBe(`the receipt records 0.0.1, but the launcher is ${version}`);
    expect(result.reasons).toEqual([
      `the extensions are 0.0.1 (npm:@zharskiy/pinata@0.0.1), the launcher is ${version}`,
      `${proposedOf(harness)} holds an organisation config that was not applied because ${harness.userConfigFile} was edited`,
    ]);
    expect(result.hint).toContain("run your organisation's install command again");
    expect(result.hint).toContain(`move ${proposedOf(harness)} over ${harness.userConfigFile} to adopt it`);
    expect(await installStatusLine(harness.deps)).toContain("; 3 warnings, see pi sandbox doctor");
  });

  it("warns when the recorded extensions source left host pi's packages", async () => {
    const harness = await createHarness();

    await writeReceiptJson(harness, await goodReceipt());

    const result = await checkInstall(harness.deps);

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("is no longer in host pi's packages");
    expect(result.hint).toContain(`pi install npm:@zharskiy/pinata@${await launcherVersion()}`);
  });

  it("puts the install line in pi sandbox status", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);
    expect(harness.stdout().split("\n")).toContain("install: installed without a receipt");
  });
});
