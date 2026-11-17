import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot, sha256Hex } from "../../shared/index.ts";
import { holdLaunch, writeManagedPi } from "./harness.ts";
import { exists, INSTALL_TIMEOUT_MS, installRoot, packageVersion, runInstall } from "./install-harness.ts";

const RECORDING = (name: string, body: string) => `echo "${name} $*" >> "$HOME/../calls.log"\n${body}`;

const RECORDING_FAKES = {
  brew: RECORDING("brew", "exit 0"),
  npm: RECORDING("npm", "exit 0"),
  colima: RECORDING("colima", 'case "$1" in version) echo "colima version 0.8.1" ;; *) exit 0 ;; esac'),
};

const calls = async (root: string) =>
  (await readFile(join(root, "calls.log"), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

const configFile = (root: string) => join(root, "config", "config.json");

const proposedFile = (root: string) => join(root, "config", "config.proposed.json");

const receiptOf = async (root: string) =>
  JSON.parse(await readFile(join(root, "state", "install.json"), "utf8")) as Record<string, unknown>;

const MARKER = "pi-sandbox-org-marker-5d2e";

const ORG = {
  credentials: {
    rules: [{ id: "llm", host: "llm.corp.test", placeholder: MARKER, secret: { env: "LLM_KEY" } }],
  },
};

const writeOrg = async (root: string, value: unknown = ORG) => {
  const file = join(root, "org.json");

  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));

  return file;
};

const RECORDING_PI = 'printf "%s\\n" "$PI_CODING_AGENT_DIR $*" >> "$HOME/../pi.log"';

const piLog = async (root: string) =>
  (await readFile(join(root, "pi.log"), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

const snapshot = async (root: string) => {
  const entries = await readdir(root, { recursive: true });
  const kept = entries.filter((entry) => !entry.startsWith("tools") && entry !== "calls.log").sort();

  return Promise.all(
    kept.map(async (entry) => {
      const info = await stat(join(root, entry));

      return info.isFile()
        ? `${entry} ${info.mode} ${sha256Hex(await readFile(join(root, entry), "utf8"))}`
        : `${entry} ${info.mode}`;
    }),
  );
};

describe("install.sh --version and --help", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("prints the package version and the installer api, and changes nothing", async () => {
    const { root } = await installRoot(RECORDING_FAKES);
    const before = await snapshot(root);
    const result = runInstall(root, ["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`@zharskiy/pinata ${await packageVersion()} (installer api 1)\n`);
    expect(await snapshot(root)).toEqual(before);
    expect(await calls(root)).toEqual([]);
  });

  it("lists every option in its usage", async () => {
    const { root } = await installRoot();
    const result = runInstall(root, ["--help"]);

    expect(result.status).toBe(0);

    [
      "--cpu N",
      "--memory GiB",
      "--disk GiB",
      "--root DIR",
      "--config FILE",
      "--config-conflict keep|replace|fail",
      "--with-extensions | --no-extensions",
      "--extensions-source SPEC",
      "--no-smoke",
      "--dry-run",
      "--version",
    ].forEach((option) => {
      expect(result.stdout).toContain(option);
    });
  });

  it("refuses a bad --config-conflict, a local --extensions-source and an empty --config with 64", async () => {
    const { root } = await installRoot(RECORDING_FAKES);
    const conflict = runInstall(root, ["--config-conflict", "merge"]);
    const source = runInstall(root, ["--extensions-source", "./checkout"]);
    const empty = runInstall(root, ["--config", ""]);
    const missing = runInstall(root, ["--config"]);

    expect([conflict.status, source.status, empty.status, missing.status]).toEqual([64, 64, 64, 64]);
    expect(conflict.stderr).toContain("options: --config-conflict must be keep, replace or fail, not merge");
    expect(source.stderr).toContain("options: --extensions-source ./checkout is not a pi package source");
    expect(empty.stderr).toContain("options: --config needs a non-empty value");
    expect(missing.stderr).toContain("options: --config needs a value");
    expect(await calls(root)).toEqual([]);
  });
});

describe("install.sh --dry-run", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("prints the plan, runs only read-only tools and writes nothing", async () => {
    const { root, home } = await installRoot(RECORDING_FAKES);
    const work = join(root, "work");
    const org = await writeOrg(root, { ...ORG, workspaceRoots: { roots: [work] } });

    await mkdir(work);

    const before = await snapshot(root);
    const result = runInstall(root, ["--dry-run", "--config", org, "--root", work, "--with-extensions"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[2/9] runtime: colima is present\n");
    expect(result.stdout).toContain(
      `[3/9] launcher: would write ${join(home, ".local", "bin", "pi")} running ${join(launcherRoot(), "bin", "pi-sandbox-dev.js")}\n`,
    );
    expect(result.stdout).toContain("[4/9] extensions: skipped, a checkout has no default source");
    expect(result.stdout).toContain(`[5/9] config: would write ${configFile(root)}\n`);
    expect(result.stdout).toContain("[6/9] colima: would start or keep profile pi-sandbox");
    expect(result.stdout).toContain("dry run: nothing was changed\n");
    expect(result.stdout).not.toContain(MARKER);
    expect(await calls(root)).toEqual(["colima version"]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("plans the brew step without running brew when colima is missing", async () => {
    const { root } = await installRoot(RECORDING_FAKES);

    await rm(join(root, "tools", "colima"));

    const result = runInstall(root, ["--dry-run", "--no-smoke"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[2/9] runtime: would install colima with Homebrew\n");
    expect(result.stdout).toContain("[8/9] smoke: skipped (--no-smoke)\n");
    expect(await calls(root)).toEqual([]);
  });

  it("exits with the code of the error the run would hit, and writes nothing", async () => {
    const { root, home } = await installRoot(RECORDING_FAKES);
    const invalid = await writeOrg(root, { egress: { blocked: [MARKER] } });
    const rejected = runInstall(root, ["--dry-run", "--config", invalid]);

    await writeFile(join(home, ".local", "bin", "pi"), "#!/bin/sh\n");

    const foreign = runInstall(root, ["--dry-run"]);

    expect(rejected.status).toBe(78);
    expect(rejected.stderr).toContain("egress.blocked is not a known key");
    expect(rejected.stderr).toContain("pi-sandbox install: config: rejected");
    expect(rejected.stderr).not.toContain(MARKER);
    expect(foreign.status).toBe(73);
    expect(await exists(configFile(root))).toBe(false);
    expect(await calls(root)).toEqual([]);
  });
});

describe("install.sh --config", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("installs the organisation config, keeps it once the user edits it, and tracks it in the receipt", async () => {
    const { root } = await installRoot(RECORDING_FAKES);
    const org = await writeOrg(root);
    const first = runInstall(root, ["--config", org]);
    const written = `${JSON.stringify(ORG, null, 2)}\n`;

    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`[5/9] config: wrote ${configFile(root)} from ${org}\n`);
    expect(await readFile(configFile(root), "utf8")).toBe(written);
    expect(await receiptOf(root)).toMatchObject({
      config: { from: org, sha256: sha256Hex(written), outcome: "created" },
    });

    const edited = JSON.stringify({ ...ORG, env: { allow: ["MINE"] } });

    await writeFile(configFile(root), edited);

    await writeOrg(root, { ...ORG, env: { allow: ["ORG"] } });

    const second = runInstall(root, ["--config", org]);

    expect(second.status).toBe(0);
    expect(second.stdout).toContain(
      `[5/9] config: kept ${configFile(root)}, which was edited; the organisation config is in ${proposedFile(root)}: compare the two, then move it over ${configFile(root)} to adopt it, or delete it to keep yours\n`,
    );
    expect(await readFile(configFile(root), "utf8")).toBe(edited);
    expect(await exists(proposedFile(root))).toBe(true);
    expect(await receiptOf(root)).toMatchObject({ config: { sha256: sha256Hex(written), outcome: "kept" } });

    const plain = runInstall(root);

    expect(plain.status).toBe(0);
    expect(await receiptOf(root)).toMatchObject({ config: { sha256: sha256Hex(written), outcome: "kept" } });
    expect([first, second, plain].some((result) => `${result.stdout}${result.stderr}`.includes(MARKER))).toBe(
      false,
    );
  });

  it("replaces the edited config with --config-conflict replace and refuses it with fail", async () => {
    const { root } = await installRoot(RECORDING_FAKES);
    const org = await writeOrg(root);
    const mine = JSON.stringify({ env: { allow: ["MINE"] } });

    await mkdir(join(root, "config"));

    await writeFile(configFile(root), mine);

    const failed = runInstall(root, ["--config", org, "--config-conflict", "fail"]);

    expect(failed.status).toBe(78);
    expect(await readFile(configFile(root), "utf8")).toBe(mine);
    expect(await calls(root)).toEqual([]);

    const replaced = runInstall(root, ["--config", org, "--config-conflict", "replace"]);

    expect(replaced.status).toBe(0);
    expect(replaced.stdout).toContain(`, the previous one is in ${configFile(root)}.bak\n`);
    expect(await readFile(`${configFile(root)}.bak`, "utf8")).toBe(mine);
  });
});

describe("install.sh --root and the receipt", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("records a config.json it writes from --root, so a later --config updates it instead of keeping it", async () => {
    const { root } = await installRoot(RECORDING_FAKES);
    const work = join(root, "work");

    await mkdir(work);

    expect(runInstall(root, ["--root", work, "--no-smoke"]).status).toBe(0);

    const written = await readFile(configFile(root), "utf8");

    expect(await receiptOf(root)).toMatchObject({
      config: { from: "--root", sha256: sha256Hex(written), outcome: "created" },
    });

    const org = await writeOrg(root);
    const later = runInstall(root, ["--config", org, "--no-smoke"]);

    expect(later.status).toBe(0);
    expect(later.stdout).toContain(`[5/9] config: updated ${configFile(root)} from ${org}\n`);
    expect(await exists(proposedFile(root))).toBe(false);
  });

  it("keeps the extensions and config it recorded when a later step fails, with the smoke check pending", async () => {
    const colima = 'case "$1" in version) echo "colima version 0.8.1" ;; start) exit 3 ;; *) exit 1 ;; esac';
    const { root, agentDir } = await installRoot({ ...RECORDING_FAKES, colima });
    const work = join(root, "work");

    await mkdir(work);

    await writeManagedPi(agentDir, "1.6.0", { wrapper: () => RECORDING_PI });

    const result = runInstall(root, ["--extensions-source", "npm:@zharskiy/pinata@0.6.0", "--root", work]);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("pi-sandbox install: colima: colima start --profile");
    expect(await receiptOf(root)).toMatchObject({
      extensions: { source: "npm:@zharskiy/pinata@0.6.0" },
      config: { from: "--root", outcome: "created" },
      smoke: "pending",
    });
  });

  it("runs the smoke check in the first existing root of the org config and never creates a root", async () => {
    const git = RECORDING("git", "exit 1");
    const { root } = await installRoot({ ...RECORDING_FAKES, git });
    const missing = join(root, "missing");
    const work = join(root, "work");

    await mkdir(work);

    const org = await writeOrg(root, { workspaceRoots: { roots: [missing, work] } });
    const result = runInstall(root, ["--config", org]);

    expect(result.status).toBe(79);
    expect((await calls(root)).filter((line) => line.startsWith("git "))).toEqual([
      expect.stringMatching(new RegExp(`^git -C ${work}/pi-sandbox-smoke\\.[^ ]+ init -q$`)),
    ]);
    expect(await exists(missing)).toBe(false);
  });

  it("skips the smoke check when none of the org config's roots exists, and creates none", async () => {
    const git = RECORDING("git", "exit 1");
    const { root } = await installRoot({ ...RECORDING_FAKES, git });
    const missing = join(root, "missing");
    const org = await writeOrg(root, { workspaceRoots: { roots: [missing] } });
    const result = runInstall(root, ["--config", org]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[8/9] smoke: skipped, none of the workspace roots exists");
    expect(await exists(missing)).toBe(false);
    expect(await receiptOf(root)).toMatchObject({ smoke: "skipped" });
  });
});

describe("install.sh unattended", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("leaves a read-only rc file alone with a note, and installs the rest", async () => {
    const { root, home } = await installRoot(RECORDING_FAKES);

    await writeFile(join(home, ".zshrc"), "# managed by someone else\n", { mode: 0o444 });

    const result = runInstall(root, ["--no-smoke"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `${join(home, ".zshrc")} is not writable, left as it is: put ${join(home, ".local", "bin")} first on PATH there yourself`,
    );
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("# managed by someone else\n");
  });

  it("stops with 70 and says why when ~/.local/bin is not writable", async () => {
    const { root, home } = await installRoot(RECORDING_FAKES);
    const bin = join(home, ".local", "bin");

    await chmod(bin, 0o555);

    const result = runInstall(root, ["--no-smoke"]);

    await chmod(bin, 0o755);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain(
      `pi-sandbox install: launcher: ${bin} cannot be created or is not writable`,
    );
  });

  it("runs the commands it streams (brew, npm, colima) with no stdin, so nothing waits for an answer", async () => {
    const reading = (name: string, body: string) => RECORDING(name, `cat >> "$HOME/../stdin.log"\n${body}`);
    const { root } = await installRoot({
      brew: reading("brew", "exit 0"),
      colima: RECORDING(
        "colima",
        'case "$1" in version) echo "colima version 0.8.1" ;; start) cat >> "$HOME/../stdin.log" ;; *) exit 1 ;; esac',
      ),
    });
    const work = join(root, "work");

    await mkdir(work);

    const result = runInstall(
      root,
      ["--root", work, "--no-smoke"],
      {},
      undefined,
      "an answer nobody asked for\n",
    );

    expect(result.status).toBe(0);
    expect((await calls(root)).some((line) => line.startsWith("colima start"))).toBe(true);
    expect(await readFile(join(root, "stdin.log"), "utf8")).toBe("");
  });
});

describe("install.sh extensions, smoke and receipt", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("installs the given source into host pi through the managed pi and records it", async () => {
    const { root, agentDir } = await installRoot(RECORDING_FAKES);

    await writeManagedPi(agentDir, "1.6.0", { wrapper: () => RECORDING_PI });

    const result = runInstall(root, ["--extensions-source", "npm:@zharskiy/pinata@0.4.0"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[4/9] extensions: installed npm:@zharskiy/pinata@0.4.0 into host pi\n");
    expect(await piLog(root)).toEqual([`${agentDir} install npm:@zharskiy/pinata@0.4.0`]);
    expect(await receiptOf(root)).toMatchObject({ extensions: { source: "npm:@zharskiy/pinata@0.4.0" } });
  });

  it("lets --no-extensions win wherever it appears, and says a checkout has no default source", async () => {
    const { root, agentDir } = await installRoot(RECORDING_FAKES);

    await writeManagedPi(agentDir, "1.6.0", { wrapper: () => RECORDING_PI });

    const off = runInstall(root, ["--no-extensions", "--extensions-source", "npm:@zharskiy/pinata@0.4.0"]);
    const bare = runInstall(root, ["--with-extensions"]);

    expect(off.status).toBe(0);
    expect(off.stdout).toContain("[4/9] extensions: skipped (--no-extensions)\n");
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain("[4/9] extensions: skipped, a checkout has no default source");
    expect(await piLog(root)).toEqual([]);
  });

  it("stops with 70 naming the step when pi install fails, before the config and the VM", async () => {
    const { root, agentDir } = await installRoot(RECORDING_FAKES);

    await writeManagedPi(agentDir, "1.6.0", { wrapper: () => "exit 2" });

    const result = runInstall(root, ["--extensions-source", "npm:@zharskiy/pinata@0.4.0"]);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain(
      "pi-sandbox install: extensions: pi install npm:@zharskiy/pinata@0.4.0 failed (exit 70), see the output above",
    );
    expect(result.stdout).not.toContain("[5/9]");
    expect(await calls(root)).toEqual(["colima version"]);
  });

  it("skips the smoke check with --no-smoke and records it", async () => {
    const { root } = await installRoot({ ...RECORDING_FAKES, git: RECORDING("git", "exit 0") });
    const result = runInstall(root, ["--no-smoke"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[7/9] image: built at the first pi launch\n");
    expect(result.stdout).toContain("[8/9] smoke: skipped (--no-smoke)");
    expect((await calls(root)).filter((line) => line.startsWith("git "))).toEqual([]);
    expect(await receiptOf(root)).toMatchObject({ smoke: "skipped" });
  });

  it("writes a checkout receipt with 0600 after a plain run, and one that says failed when the smoke check fails", async () => {
    const { root } = await installRoot(RECORDING_FAKES);

    expect(runInstall(root).status).toBe(0);
    expect((await stat(join(root, "state", "install.json"))).mode & 0o777).toBe(0o600);
    expect(await receiptOf(root)).toMatchObject({
      schemaVersion: 1,
      installerApi: 1,
      package: { name: "@zharskiy/pinata", version: await packageVersion(), spec: null, mode: "checkout" },
      bootstrap: null,
      pi: { version: "1.6.0" },
      extensions: null,
      config: null,
      smoke: "skipped",
    });

    const failing = await installRoot({ ...RECORDING_FAKES, git: "exit 1" });
    const failed = runInstall(failing.root, [], {
      PI_INSTALL_BOOTSTRAP_API: "1",
      PI_INSTALL_BOOTSTRAP_VERSION: "0.4.0",
    });

    expect(failed.status).toBe(79);
    expect(failed.stderr).toContain("pi-sandbox install: smoke: the smoke check failed");
    expect(await receiptOf(failing.root)).toMatchObject({
      smoke: "failed",
      bootstrap: { api: 1, version: "0.4.0" },
    });
  });
});

const PACKAGE_FOLDERS = [
  "backend",
  "cli",
  "config",
  "container",
  "examples",
  "grants",
  "hostpi",
  "image",
  "provision",
  "proxy",
  "schema",
  "shared",
  "workspace",
];

const packageCopy = async (dir: string) => {
  const launcher = join(dir, "launcher");

  await mkdir(join(launcher, "bin"), { recursive: true });

  await copyFile(join(launcherRoot(), "..", "package.json"), join(dir, "package.json"));

  await Promise.all([
    ...["install.sh", "uninstall.sh"].map((name) =>
      copyFile(join(launcherRoot(), name), join(launcher, name)),
    ),
    ...["path-block.sh", "paths.sh", "pi-sandbox-dev.js", "pi-sandbox.js"].map((name) =>
      copyFile(join(launcherRoot(), "bin", name), join(launcher, "bin", name)),
    ),
    ...PACKAGE_FOLDERS.map((name) => symlink(join(launcherRoot(), name), join(launcher, name))),
  ]);

  return launcher;
};

const globalSetup = async () => {
  const npmRoot = "$HOME/../npm/lib/node_modules";
  const npm = RECORDING(
    "npm",
    `case "$1 $2" in "root -g") echo "${npmRoot}" ;; "prefix -g") echo "$HOME/../npm" ;; esac`,
  );
  const setup = await installRoot({ ...RECORDING_FAKES, npm });
  const prefix = join(setup.root, "npm");
  const globalPackage = join(prefix, "lib", "node_modules", "@zharskiy/pinata");
  const bin = join(prefix, "bin", "pi-sandbox");

  await mkdir(join(prefix, "bin"), { recursive: true });

  await writeFile(bin, `#!/bin/sh\nexec node '${join(launcherRoot(), "bin", "pi-sandbox-dev.js")}' "$@"\n`, {
    mode: 0o755,
  });

  return { ...setup, prefix, globalPackage, bin };
};

const runFrom = (launcher: string, root: string, flags: string[] = [], env: Record<string, string> = {}) =>
  runInstall(root, flags, env, join(launcher, "install.sh"));

describe("install.sh from an installed package", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("skips npm install when it runs from the global install, and links the shim to its bin", async () => {
    const { root, home, globalPackage, bin } = await globalSetup();
    const launcher = await packageCopy(globalPackage);
    const result = runFrom(launcher, root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("running from the global install of @zharskiy/pinata@");
    expect((await calls(root)).filter((line) => line.startsWith("npm install"))).toEqual([]);
    expect(await readFile(join(home, ".local", "bin", "pi"), "utf8")).toBe(await readFile(bin, "utf8"));
    expect(await receiptOf(root)).toMatchObject({
      package: { mode: "global", spec: `@zharskiy/pinata@${await packageVersion()}` },
    });
  });

  it("installs its own version with npm from elsewhere, or PI_SANDBOX_NPM_SPEC", async () => {
    const { root } = await globalSetup();
    const launcher = await packageCopy(join(root, "unpacked"));
    const version = await packageVersion();
    const plain = runFrom(launcher, root);

    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain(`[3/9] launcher: installing @zharskiy/pinata@${version} with npm\n`);

    const spec = runFrom(launcher, root, [], { PI_SANDBOX_NPM_SPEC: "/tmp/zharskiy-pinata.tgz" });

    expect(spec.status).toBe(0);
    expect((await calls(root)).filter((line) => line.startsWith("npm install"))).toEqual([
      `npm install -g --omit=peer @zharskiy/pinata@${version}`,
      "npm install -g --omit=peer /tmp/zharskiy-pinata.tgz",
    ]);
    expect(await receiptOf(root)).toMatchObject({ package: { spec: "/tmp/zharskiy-pinata.tgz" } });
  });

  it("uninstalls the pre-release name of this package before npm install, so its pi-sandbox bin does not clash", async () => {
    const { root, prefix } = await globalSetup();
    const launcher = await packageCopy(join(root, "unpacked"));
    const version = await packageVersion();

    await mkdir(join(prefix, "lib", "node_modules", "pi-extensions-mz"), { recursive: true });

    const dry = runFrom(launcher, root, ["--dry-run"]);

    expect(dry.stdout).toContain("would uninstall pi-extensions-mz (the pre-release name of this package)");

    const result = runFrom(launcher, root);

    expect(result.status).toBe(0);
    expect((await calls(root)).filter((line) => /^npm (un)?install/.test(line))).toEqual([
      "npm uninstall -g pi-extensions-mz",
      `npm install -g --omit=peer @zharskiy/pinata@${version}`,
    ]);
  });

  it("stops with 75 before anything changes when pi sessions are live and another version is installed", async () => {
    const { root, home, globalPackage } = await globalSetup();
    const launcher = await packageCopy(join(root, "unpacked"));

    await mkdir(globalPackage, { recursive: true });

    await writeFile(
      join(globalPackage, "package.json"),
      '{\n  "name": "@zharskiy/pinata",\n  "version": "0.0.1"\n}\n',
    );

    await holdLaunch({ stateDir: join(root, "state"), repoRoot: join(root, "repo") });

    const result = runFrom(launcher, root);

    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      "pi-sandbox install: launcher: pi sessions are live, nothing was changed",
    );
    expect((await calls(root)).filter((line) => !line.endsWith(" -g") && line !== "colima version")).toEqual(
      [],
    );
    expect(await exists(join(home, ".zshrc"))).toBe(false);
  });
});
