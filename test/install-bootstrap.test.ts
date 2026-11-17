import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const BOOTSTRAP = join(ROOT, "install.sh");
const PACKAGE = "@zharskiy/pinata";
const TIMEOUT_MS = 30_000;
const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const OLDER = "0.0.1";
const OTHER = "9.9.9";
const COMPLETE = "--pinata-bootstrap-complete";
const LEGACY = "pi-extensions-mz";

const SYSTEM_TOOLS = ["awk", "cat", "chmod", "cp", "grep", "head", "mkdir", "mktemp", "rm", "sed", "sh"];

const MANAGED_MARKER = { kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" };

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const toolPath = (name: string) =>
  spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

const writeText = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, text);
};

const writeScript = async (path: string, body: string) => {
  await writeText(path, `#!/bin/sh\n${body}\n`);

  await chmod(path, 0o755);
};

const readOr = (path: string, fallback = "") => readFile(path, "utf8").catch(() => fallback);

const managedPiScript = (dir: string) =>
  [
    `mkdir -p "${dir}/bin" "${dir}/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent"`,
    `printf '%s\\n' '#!/bin/sh' > "${dir}/bin/pi"`,
    `chmod 0755 "${dir}/bin/pi"`,
    `printf '%s\\n' '${JSON.stringify(MANAGED_MARKER)}' > "${dir}/install/managed-install.json"`,
    `printf '%s\\n' 1.5.2 > "${dir}/install/current-version"`,
    `printf '%s\\n' '{}' > "${dir}/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/package.json"`,
  ].join("\n");

const writeManagedPi = (dir: string) => {
  const result = spawnSync("/bin/sh", ["-c", managedPiScript(dir)]);

  expect(result.status).toBe(0);
};

const stageOneScript = (log: string, version: string) =>
  [
    `if [ "\${1:-}" = --version ]; then`,
    `  printf '%s\\n' "${PACKAGE} ${version} (installer api 1)"`,
    "  exit 0",
    "fi",
    `printf '[%s]\\n' "$@" > "${log}/stage1.args"`,
    `printf '%s\\n' "api=$PI_INSTALL_BOOTSTRAP_API" "bootstrap=$PI_INSTALL_BOOTSTRAP_VERSION" "spec=$PI_SANDBOX_NPM_SPEC" > "${log}/stage1.env"`,
    `exit "\${STAGE1_STATUS:-0}"`,
  ].join("\n");

const OLD_STAGE_ONE = `case "\${1:-}" in --version) echo "unknown option --version" >&2; exit 1 ;; esac\nexit 0`;

interface PackageOptions {
  version: string;
  stageOne?: string;
  busyStatus?: number;
}

const writePackage = async (dir: string, log: string, options: PackageOptions) => {
  await writeText(
    join(dir, "package.json"),
    `{\n  "name": "${PACKAGE}",\n  "version": "${options.version}"\n}\n`,
  );

  await writeScript(
    join(dir, "launcher", "install.sh"),
    options.stageOne ?? stageOneScript(log, options.version),
  );

  await writeText(
    join(dir, "launcher", "bin", "pi-sandbox.js"),
    `require("node:fs").appendFileSync(${JSON.stringify(join(log, "busy.log"))}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(${options.busyStatus ?? 0});\n`,
  );
};

const npmScript = (log: string, global: string, staged: string) =>
  [
    `printf '%s\\n' "$*" >> "${log}/npm.log"`,
    'case "$1" in',
    `  root) printf '%s\\n' "${global}" ;;`,
    "  install)",
    `    if [ -n "\${NPM_FAIL:-}" ]; then exit 1; fi`,
    `    rm -rf "${global}/${PACKAGE}"`,
    `    mkdir -p "${dirname(join(global, PACKAGE))}"`,
    `    cp -R "${staged}" "${global}/${PACKAGE}"`,
    "    ;;",
    "  uninstall)",
    `    rm -rf "${global}/$3"`,
    "    ;;",
    "esac",
  ].join("\n");

const piInstallerScript = (log: string) =>
  [
    `printf '%s\\n' "agent=\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "api=\${PI_INSTALLER_API_BASE:-}" > "${log}/pi-installer.env"`,
    `if [ -t 0 ]; then echo stdin-tty >> "${log}/pi-installer.env"; else echo stdin-not-tty >> "${log}/pi-installer.env"; fi`,
    `if (: < /dev/tty) 2>/dev/null; then echo dev-tty >> "${log}/pi-installer.env"; else echo no-dev-tty >> "${log}/pi-installer.env"; fi`,
    `if [ -n "\${PI_INSTALLER_FAIL:-}" ]; then exit 3; fi`,
    `if [ -n "\${PI_INSTALLER_NOOP:-}" ]; then exit 0; fi`,
    managedPiScript(`\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`),
  ].join("\n");

interface SandboxOptions {
  managedPi?: boolean;
  installed?: PackageOptions;
  staged?: PackageOptions;
  fakes?: Record<string, string>;
  withoutNode?: boolean;
}

const sandbox = async (options: SandboxOptions = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-bootstrap-")));

  created.push(root);

  const home = join(root, "home");
  const tools = join(root, "tools");
  const log = join(root, "log");
  const global = join(root, "global", "lib", "node_modules");
  const staged = join(root, "staged");
  const agentDir = join(home, ".pi", "agent");
  const installer = join(root, "pi-installer.sh");

  await Promise.all([mkdir(home, { recursive: true }), mkdir(tools, { recursive: true }), mkdir(log)]);

  const fakes: Record<string, string> = {
    id: "echo 501",
    sw_vers: "echo 15.1",
    brew: "exit 0",
    uname: 'case "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac',
    npm: npmScript(log, global, staged),
    curl: `printf '%s\\n' "$*" >> "${log}/curl.log"\nwhile [ "$#" -gt 1 ]; do if [ "$1" = -o ]; then cp "${installer}" "$2"; fi; shift; done`,
    ...options.fakes,
  };

  await Promise.all([
    ...SYSTEM_TOOLS.map((name) => symlink(toolPath(name), join(tools, name))),
    ...(options.withoutNode === true ? [] : [symlink(process.execPath, join(tools, "node"))]),
    ...Object.entries(fakes).map(([name, body]) => writeScript(join(tools, name), body)),
    writeScript(installer, piInstallerScript(log)),
    writePackage(staged, log, options.staged ?? { version: VERSION }),
  ]);

  if (options.managedPi !== false) {
    writeManagedPi(agentDir);
  }

  if (options.installed !== undefined) {
    await writePackage(join(global, PACKAGE), log, options.installed);
  }

  const run = (args: string[] = [], env: Record<string, string> = {}, script = BOOTSTRAP) =>
    spawnSync("/bin/sh", [script, ...args], {
      env: { HOME: home, PATH: tools, TMPDIR: root, ...env },
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });

  const npmCalls = async () => (await readOr(join(log, "npm.log"))).split("\n").filter((line) => line !== "");

  return { root, home, log, global, agentDir, installer, run, npmCalls };
};

describe("install.sh (bootstrap) pi step", { timeout: TIMEOUT_MS }, () => {
  it("leaves a managed pi alone and never runs pi's installer", async () => {
    const box = await sandbox();
    const result = box.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pi's installer is not run");
    expect(await readOr(join(box.log, "curl.log"), "none")).toBe("none");
    expect(await readOr(join(box.log, "pi-installer.env"), "none")).toBe("none");
  });

  it("downloads pi's installer and runs it without a terminal, with the environment passed through", async () => {
    const box = await sandbox({ managedPi: false });
    const agentDir = join(box.root, "agent");
    const result = box.run([], {
      PI_CODING_AGENT_DIR: agentDir,
      PI_INSTALLER_API_BASE: "https://mirror.example.com/pi",
      PI_INSTALLER_URL: "https://mirror.example.com/install.sh",
    });
    const env = await readOr(join(box.log, "pi-installer.env"));

    expect(result.status).toBe(0);
    expect(await readOr(join(box.log, "curl.log"))).toContain("https://mirror.example.com/install.sh");
    expect(env).toContain(`agent=${agentDir}`);
    expect(env).toContain("api=https://mirror.example.com/pi");
    expect(env).toContain("stdin-not-tty");
    expect(env).toContain("no-dev-tty");
    expect(await readOr(join(box.log, "stage1.args"))).toBe("[--with-extensions]\n");
  });

  it("installs pi only through pi's own installer, never with npm", async () => {
    const box = await sandbox({ managedPi: false });

    expect(box.run().status).toBe(0);
    expect(await readOr(join(box.log, "pi-installer.env"))).toContain("agent=");
    expect((await box.npmCalls()).filter((call) => call.includes("pi-coding-agent"))).toEqual([]);
    expect((await box.npmCalls()).filter((call) => call.startsWith("install"))).toEqual([
      `install -g --omit=peer ${PACKAGE}@${VERSION}`,
    ]);
  });

  it("runs a local --pi-installer file without downloading", async () => {
    const box = await sandbox({ managedPi: false });
    const result = box.run(["--pi-installer", box.installer]);

    expect(result.status).toBe(0);
    expect(await readOr(join(box.log, "curl.log"), "none")).toBe("none");
    expect(await readOr(join(box.log, "pi-installer.env"))).toContain("stdin-not-tty");
  });

  it("refuses with 69 under --skip-pi when no managed pi exists", async () => {
    const box = await sandbox({ managedPi: false });
    const result = box.run(["--skip-pi"]);

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("--skip-pi");
    expect(await box.npmCalls()).toEqual([]);
  });

  it("fails with 70 when pi's installer fails or leaves no managed pi", async () => {
    const failing = await sandbox({ managedPi: false });
    const failed = failing.run([], { PI_INSTALLER_FAIL: "1" });

    expect(failed.status).toBe(70);
    expect(failed.stderr).toContain("pi's installer failed with status 3");

    const empty = await sandbox({ managedPi: false });
    const noPi = empty.run([], { PI_INSTALLER_NOOP: "1" });

    expect(noPi.status).toBe(70);
    expect(noPi.stderr).toContain("there is no managed pi");
    expect(await empty.npmCalls()).toEqual([]);
  });
});

describe("install.sh (bootstrap) preflight", { timeout: TIMEOUT_MS }, () => {
  it("refuses root with 69", async () => {
    const box = await sandbox({ fakes: { id: "echo 0" } });
    const result = box.run();

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("not as root");
    expect(await box.npmCalls()).toEqual([]);
  });

  it("refuses a system other than macOS with 69", async () => {
    const box = await sandbox({ fakes: { uname: "echo Linux" } });
    const result = box.run();

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("unsupported system Linux");
  });

  it("refuses an old macOS or a missing Homebrew with 69 before it changes anything", async () => {
    const old = await sandbox({ managedPi: false, fakes: { sw_vers: "echo 12.7" } });
    const tooOld = old.run();

    expect(tooOld.status).toBe(69);
    expect(tooOld.stderr).toContain("macOS 12.7 is too old");
    expect(await readOr(join(old.log, "pi-installer.env"), "none")).toBe("none");
    expect(await old.npmCalls()).toEqual([]);

    const noBrew = await sandbox({ managedPi: false });

    await rm(join(noBrew.root, "tools", "brew"));

    const missing = noBrew.run();

    expect(missing.status).toBe(69);
    expect(missing.stderr).toContain("Homebrew is missing");
    expect(await readOr(join(noBrew.log, "pi-installer.env"), "none")).toBe("none");
  });

  it("never leaks a raw exit status when a helper tool fails", async () => {
    const box = await sandbox({ managedPi: false });

    await rm(join(box.root, "tools", "rm"));

    await writeScript(join(box.root, "tools", "rm"), "exit 5");

    const result = box.run();

    expect([0, 70]).toContain(result.status);
  });

  it("refuses a missing or old node with 69 and names the fix", async () => {
    const missing = await sandbox({ withoutNode: true });
    const none = missing.run();

    expect(none.status).toBe(69);
    expect(none.stderr).toContain("node is missing, install Node 22.19.0 or newer");

    const old = await sandbox({ withoutNode: true, fakes: { node: "echo 22.18.9" } });
    const tooOld = old.run();

    expect(tooOld.status).toBe(69);
    expect(tooOld.stderr).toContain("node 22.18.9 is too old");
  });

  it("refuses a missing npm with 69", async () => {
    const box = await sandbox();

    await rm(join(box.root, "tools", "npm"));

    const result = box.run();

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("npm is missing");
  });

  it("rejects a stage-0 option without its value with 64", async () => {
    const box = await sandbox();
    const result = box.run(["--package-version"]);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("--package-version needs a value");
  });
});

describe("install.sh (bootstrap) package step", { timeout: TIMEOUT_MS }, () => {
  it("installs the baked-in version by default", async () => {
    const box = await sandbox();

    expect(box.run().status).toBe(0);
    expect(await box.npmCalls()).toEqual(["root -g", `install -g --omit=peer ${PACKAGE}@${VERSION}`]);
  });

  it("installs --package-version, or PINATA_VERSION", async () => {
    const flag = await sandbox({ staged: { version: "9.6.1" } });

    expect(flag.run(["--package-version", "9.6.1"]).status).toBe(0);
    expect(await flag.npmCalls()).toContain(`install -g --omit=peer ${PACKAGE}@9.6.1`);
    expect(await readOr(join(flag.log, "stage1.env"))).toContain(`spec=${PACKAGE}@9.6.1`);

    const env = await sandbox({ staged: { version: "9.6.2" } });

    expect(env.run([], { PINATA_VERSION: "9.6.2" }).status).toBe(0);
    expect(await env.npmCalls()).toContain(`install -g --omit=peer ${PACKAGE}@9.6.2`);
  });

  it("lets a flag win over its variable, and --package win over --package-version", async () => {
    const flagOverEnv = await sandbox({ staged: { version: "9.6.1" } });

    expect(flagOverEnv.run(["--package-version", "9.6.1"], { PINATA_VERSION: "9.6.2" }).status).toBe(0);
    expect(await flagOverEnv.npmCalls()).toContain(`install -g --omit=peer ${PACKAGE}@9.6.1`);

    const versionFlagOverPackageEnv = await sandbox({ staged: { version: "9.6.1" } });
    const env = { PINATA_PACKAGE: "https://artifacts.example.com/zharskiy-pinata-9.6.3.tgz" };

    expect(versionFlagOverPackageEnv.run(["--package-version", "9.6.1"], env).status).toBe(0);
    expect(await versionFlagOverPackageEnv.npmCalls()).toContain(`install -g --omit=peer ${PACKAGE}@9.6.1`);

    const packageEnvOverVersionEnv = await sandbox();

    expect(packageEnvOverVersionEnv.run([], { ...env, PINATA_VERSION: "9.6.2" }).status).toBe(0);
    expect(await packageEnvOverVersionEnv.npmCalls()).toContain(
      `install -g --omit=peer ${env.PINATA_PACKAGE}`,
    );
  });

  it("skips npm install when the wanted version is installed and its installer answers", async () => {
    const box = await sandbox({ installed: { version: VERSION, busyStatus: 75 } });
    const result = box.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm install is skipped");
    expect(await box.npmCalls()).toEqual(["root -g"]);
    expect(await readOr(join(box.log, "stage1.args"))).toBe("[--with-extensions]\n");
  });

  it("reinstalls the wanted version when its installer does not answer --version", async () => {
    const box = await sandbox({ installed: { version: VERSION, stageOne: "exit 1" } });

    expect(box.run().status).toBe(0);
    expect(await box.npmCalls()).toContain(`install -g --omit=peer ${PACKAGE}@${VERSION}`);
  });

  it("takes the wanted version from a tarball named zharskiy-pinata-X.Y.Z.tgz", async () => {
    const same = await sandbox({ installed: { version: VERSION, busyStatus: 75 } });
    const tarball = `https://files.example.com/pi/zharskiy-pinata-${VERSION}.tgz`;

    expect(same.run(["--package", tarball]).status).toBe(0);
    expect(await same.npmCalls()).toEqual(["root -g"]);

    const other = await sandbox({ installed: { version: VERSION, busyStatus: 75 } });

    expect(other.run(["--package", `/srv/zharskiy-pinata-${OTHER}.tgz`]).status).toBe(75);
  });

  it("uninstalls the pre-release package name before installing, so its bin link does not collide", async () => {
    const box = await sandbox({ installed: { version: VERSION } });

    await writeText(join(box.global, LEGACY, "package.json"), `{"name":"${LEGACY}","version":"0.3.0"}\n`);

    const result = box.run();

    expect(result.status).toBe(0);
    expect((await box.npmCalls()).slice(1)).toEqual([
      `uninstall -g ${LEGACY}`,
      `install -g --omit=peer ${PACKAGE}@${VERSION}`,
    ]);
  });

  it("installs --package verbatim and lets it win over --package-version", async () => {
    const box = await sandbox();
    const tarball = "https://artifacts.example.com/zharskiy-pinata-9.6.0.tgz";

    expect(box.run(["--package", tarball, "--package-version", OTHER]).status).toBe(0);
    expect(await box.npmCalls()).toContain(`install -g --omit=peer ${tarball}`);
    expect(await readOr(join(box.log, "stage1.env"))).toContain(`spec=${tarball}`);
  });

  it("fails with 70 when npm install fails, and runs no installer", async () => {
    const box = await sandbox();
    const result = box.run([], { NPM_FAIL: "1" });

    expect(result.status).toBe(70);
    expect(result.stderr).toContain(`npm install -g --omit=peer ${PACKAGE}@${VERSION} failed`);
    expect(await readOr(join(box.log, "stage1.args"), "none")).toBe("none");
  });

  it("stops with 75 when the installed launcher reports live sessions, before npm runs", async () => {
    const box = await sandbox({ installed: { version: OLDER, busyStatus: 75 } });
    const result = box.run();

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("end the pi sessions and run this again");
    expect(await readOr(join(box.log, "busy.log"))).toBe("__busy\n");
    expect((await box.npmCalls()).filter((call) => call.startsWith("install"))).toEqual([]);
  });

  it("proceeds when the installed launcher answers __busy with another status", async () => {
    const box = await sandbox({ installed: { version: OLDER, busyStatus: 1 } });

    expect(box.run().status).toBe(0);
    expect(await readOr(join(box.log, "busy.log"))).toBe("__busy\n");
    expect(await box.npmCalls()).toContain(`install -g --omit=peer ${PACKAGE}@${VERSION}`);
  });

  it("never sends __busy to a launcher that predates the installer api, since it would start pi", async () => {
    const box = await sandbox({ installed: { version: OLDER, stageOne: OLD_STAGE_ONE, busyStatus: 75 } });

    expect(box.run().status).toBe(0);
    expect(await readOr(join(box.log, "busy.log"), "none")).toBe("none");
  });

  it("asks no busy question when the wanted version is already installed", async () => {
    const box = await sandbox({ installed: { version: VERSION, busyStatus: 75 } });

    expect(box.run().status).toBe(0);
    expect(await readOr(join(box.log, "busy.log"), "none")).toBe("none");
  });

  it("asks the busy question for a --package whose version is unknown", async () => {
    const box = await sandbox({ installed: { version: VERSION, busyStatus: 75 } });

    expect(box.run(["--package", "/tmp/zharskiy-pinata.tgz"]).status).toBe(75);
  });

  it("reads the wanted version from a scoped --package spec of this package", async () => {
    const same = await sandbox({ installed: { version: VERSION, busyStatus: 75 } });

    expect(same.run(["--package", `${PACKAGE}@${VERSION}`]).status).toBe(0);
    expect(await readOr(join(same.log, "busy.log"), "none")).toBe("none");

    const other = await sandbox({ installed: { version: VERSION, busyStatus: 75 } });

    expect(other.run(["--package", `${PACKAGE}@${OTHER}`]).status).toBe(75);
  });

  it("exits 69 when the installed package predates the one-step installer", async () => {
    const box = await sandbox({ staged: { version: OLDER, stageOne: OLD_STAGE_ONE } });
    const result = box.run(["--package-version", OLDER]);

    expect(result.status).toBe(69);
    expect(result.stderr).toContain("predates the one-step installer");
  });
});

describe("install.sh (bootstrap) hand-over to stage 1", { timeout: TIMEOUT_MS }, () => {
  it("passes unknown arguments verbatim and in order after --with-extensions, with the bootstrap environment", async () => {
    const box = await sandbox();
    const args = ["--root", "/Users/me/my work", "--config", "org.json", "--future-flag", "a'b\"c", ""];
    const result = box.run([
      "--skip-pi",
      ...args.slice(0, 2),
      "--package-version",
      VERSION,
      ...args.slice(2),
    ]);

    expect(result.status).toBe(0);
    expect(await readOr(join(box.log, "stage1.args"))).toBe(
      ["--with-extensions", ...args].map((arg) => `[${arg}]\n`).join(""),
    );
    expect(await readOr(join(box.log, "stage1.env"))).toBe(
      `api=1\nbootstrap=${VERSION}\nspec=${PACKAGE}@${VERSION}\n`,
    );
  });

  it("returns stage 1's exit status", async () => {
    const box = await sandbox();

    expect(box.run([], { STAGE1_STATUS: "79" }).status).toBe(79);
  });

  it("prints its version with the bootstrap api and runs nothing", async () => {
    const box = await sandbox();
    const result = box.run(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${PACKAGE} bootstrap ${VERSION} (bootstrap api 1)\n`);
    expect(await box.npmCalls()).toEqual([]);
  });
});

describe("install.sh (bootstrap) dry run", { timeout: TIMEOUT_MS }, () => {
  it("changes nothing and calls no mutating tool when the package is not installed", async () => {
    const box = await sandbox({ managedPi: false });
    const result = box.run(["--dry-run", "--root", "/x"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would run pi's installer");
    expect(result.stdout).toContain(`would run npm install -g --omit=peer ${PACKAGE}@${VERSION}`);
    expect(result.stdout).toContain(
      `would run sh ${join(box.global, PACKAGE, "launcher", "install.sh")} --with-extensions --dry-run --root /x`,
    );
    expect(await box.npmCalls()).toEqual(["root -g"]);
    expect(await readOr(join(box.log, "curl.log"), "none")).toBe("none");
    expect(await readOr(join(box.log, "pi-installer.env"), "none")).toBe("none");
    expect(await readOr(join(box.log, "stage1.args"), "none")).toBe("none");
  });

  it("does not run stage 1 when pi is missing, since its preflight would refuse what the real run fixes", async () => {
    const box = await sandbox({ managedPi: false, installed: { version: VERSION } });
    const result = box.run(["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm install would be skipped");
    expect(result.stdout).toContain("would run sh ");
    expect(await readOr(join(box.log, "stage1.args"), "none")).toBe("none");
  });

  it("names the uninstall of the pre-release package and runs nothing", async () => {
    const box = await sandbox();

    await writeText(join(box.global, LEGACY, "package.json"), `{"name":"${LEGACY}","version":"0.3.0"}\n`);

    const result = box.run(["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`would run npm uninstall -g ${LEGACY}`);
    expect(await box.npmCalls()).toEqual(["root -g"]);
  });

  it("forwards --dry-run to the installed stage 1 of the wanted version", async () => {
    const box = await sandbox({ installed: { version: VERSION } });
    const result = box.run(["--dry-run", "--root", "/x"]);

    expect(result.status).toBe(0);
    expect(await box.npmCalls()).toEqual(["root -g"]);
    expect(await readOr(join(box.log, "stage1.args"))).toBe(
      "[--with-extensions]\n[--dry-run]\n[--root]\n[/x]\n",
    );
  });
});

describe("install.sh (bootstrap) file", { timeout: TIMEOUT_MS }, () => {
  it("runs nothing when the download is cut anywhere before its last line", async () => {
    const box = await sandbox();
    const text = await readFile(BOOTSTRAP, "utf8");
    const lastLine = text.trimEnd().lastIndexOf("\n") + 1;
    const lastEnd = text.trimEnd().length;
    const cuts = [
      ...Array.from({ length: 24 }, (_, index) => Math.floor((lastLine * index) / 24)),
      ...Array.from({ length: lastEnd - lastLine + 1 }, (_, index) => lastLine - 1 + index),
    ];

    await Promise.all(cuts.map((cut) => writeText(join(box.root, `cut-${cut}.sh`), text.slice(0, cut))));

    const bare = cuts.map((cut) => box.run([], {}, join(box.root, `cut-${cut}.sh`)));
    const withArgs = cuts.map((cut) => box.run(["--root", "/x"], {}, join(box.root, `cut-${cut}.sh`)));

    expect([...bare, ...withArgs].map((result) => result.stdout)).toEqual([...cuts, ...cuts].map(() => ""));
    expect(await box.npmCalls()).toEqual([]);
    expect(await readOr(join(box.log, "stage1.args"), "none")).toBe("none");
  });

  it("runs when the last line is complete even without its newline", async () => {
    const box = await sandbox();
    const text = (await readFile(BOOTSTRAP, "utf8")).trimEnd();

    await writeText(join(box.root, "whole.sh"), text);

    expect(box.run([], {}, join(box.root, "whole.sh")).status).toBe(0);
    expect(await readOr(join(box.log, "stage1.args"))).toBe("[--with-extensions]\n");
  });

  it("bakes in the package.json version on the release-please marker line, its only comment", async () => {
    const text = await readFile(BOOTSTRAP, "utf8");
    const comments = text.split("\n").filter((line, index) => index > 0 && /(^|\s)#(\s|$)/.test(line));

    expect(text).toContain(`\nbootstrap_version=${VERSION} # x-release-please-version\n`);
    expect(comments).toEqual([`bootstrap_version=${VERSION} # x-release-please-version`]);
    expect(text.trimEnd().split("\n").at(-1)).toBe(`pinata_bootstrap "$@" ${COMPLETE}`);
  });

  it("parses as POSIX sh", () => {
    expect(spawnSync("/bin/sh", ["-n", BOOTSTRAP]).status).toBe(0);
  });
});
