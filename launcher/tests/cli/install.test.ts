import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";
import { writeManagedPi } from "./harness.ts";

const SYSTEM_TOOLS = [
  "awk",
  "cat",
  "chmod",
  "dirname",
  "grep",
  "head",
  "mkdir",
  "mktemp",
  "readlink",
  "rm",
  "rmdir",
  "sed",
];

const FAKES: Record<string, string> = {
  id: "echo 501",
  uname: 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac',
  sw_vers: "echo 15.0",
  brew: "exit 0",
  npm: "exit 0",
  colima: 'case "$1" in version) echo "colima version 0.8.1" ;; *) exit 0 ;; esac',
};

const toolPath = (name: string) =>
  spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

const writeTools = async (dir: string, fakes: Record<string, string>) => {
  await mkdir(dir, { recursive: true });

  await Promise.all([
    ...SYSTEM_TOOLS.map((name) => symlink(toolPath(name), join(dir, name))),
    symlink(process.execPath, join(dir, "node")),
    ...Object.entries(fakes).map(async ([name, body]) => {
      await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);

      await chmod(join(dir, name), 0o755);
    }),
  ]);
};

const installRoot = async (fakes: Record<string, string> = {}, homeName = "home") => {
  const root = await realpath(await tempDir("install"));
  const home = join(root, homeName);
  const agentDir = join(home, ".pi", "agent");

  await writeTools(join(root, "tools"), { ...FAKES, ...fakes });

  await mkdir(join(home, ".local", "bin"), { recursive: true });

  const managed = await writeManagedPi(agentDir, "1.6.0");

  return { root, home, agentDir, managed, record: join(root, "state", "replaced-pi-link") };
};

const INSTALL_TIMEOUT_MS = 30_000;

const runInstall = (root: string, flags: string[] = [], extraEnv: Record<string, string> = {}) =>
  spawnSync("/bin/sh", [join(launcherRoot(), "install.sh"), ...flags], {
    env: {
      ...extraEnv,
      HOME: join(root, "home"),
      PATH: join(root, "tools"),
      PI_SANDBOX_STATE_DIR: join(root, "state"),
      PI_SANDBOX_USER_CONFIG: join(root, "config", "config.json"),
      PI_SANDBOX_POLICY_FILE: join(root, "policy.json"),
    },
    encoding: "utf8",
  });

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const isLauncherWrapper = async (path: string) =>
  (await readFile(path, "utf8")).includes("launcher/bin/pi-sandbox-dev.js");

describe("install.sh and pi's managed install", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("takes over a relative link chain to the managed pi and records the link it replaced", async () => {
    const { root, home, agentDir, record } = await installRoot();
    const shim = join(home, ".local", "bin", "pi");

    await mkdir(join(home, ".local", "lib"), { recursive: true });

    await symlink("../../.pi/agent/bin/pi", join(home, ".local", "lib", "pi-link"));

    await symlink("../lib/pi-link", shim);

    const result = runInstall(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `; the managed pi at ${agentDir}/bin/pi stays the host pi for host jobs and pi --no-sandbox (uninstall.sh restores the link)`,
    );
    expect(result.stdout).toContain("[6/7] smoke: skipped, git is missing");
    expect(await readFile(record, "utf8")).toBe("../lib/pi-link\n");
    expect(await isLauncherWrapper(shim)).toBe(true);
  });

  it("carries over only the replaced-link record of the old state folder, and only when the new one is missing", async () => {
    const { root, home, record } = await installRoot();
    const legacy = join(home, ".local", "state", "pi-sandbox", "replaced-pi-link");

    await mkdir(dirname(legacy), { recursive: true });

    await writeFile(legacy, "../../.pi/agent/bin/pi\n");

    expect(runInstall(root).status).toBe(0);
    expect(await readFile(record, "utf8")).toBe("../../.pi/agent/bin/pi\n");
    expect(await readFile(legacy, "utf8")).toBe("../../.pi/agent/bin/pi\n");

    await writeFile(record, "kept\n");

    expect(runInstall(root).status).toBe(0);
    expect(await readFile(record, "utf8")).toBe("kept\n");
  });

  it("finds the managed pi of an agent dir given with ~ as pi does", async () => {
    const { root, home } = await installRoot();

    await writeManagedPi(join(home, "work", "agent"), "1.6.0");

    await rm(join(home, ".pi"), { recursive: true, force: true });

    expect(runInstall(root, [], { PI_CODING_AGENT_DIR: "~/work/agent" }).status).toBe(0);
  });

  it("refuses a pi that is neither the launcher nor pi's managed install, and records nothing", async () => {
    const { root, home, record } = await installRoot();
    const shim = join(home, ".local", "bin", "pi");

    await writeFile(shim, "#!/bin/sh\necho mine\n");

    const result = runInstall(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${shim} exists and is not the pi-sandbox launcher, move it away and run this again`,
    );
    expect(await readFile(shim, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(await exists(record)).toBe(false);
  });

  it("refuses a managed install outside the host agent dir", async () => {
    const { root, home, record } = await installRoot();
    const shim = join(home, ".local", "bin", "pi");
    const elsewhere = join(root, "other-agent");

    await writeManagedPi(elsewhere, "1.6.0");

    await symlink(join(elsewhere, "bin", "pi"), shim);

    const result = runInstall(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${shim} is pi's managed install at ${elsewhere}, outside the host agent dir ${join(home, ".pi", "agent")}; the launcher uses only the managed install in the agent dir, move it away and run this again`,
    );
    expect(await readlink(shim)).toBe(join(elsewhere, "bin", "pi"));
    expect(await exists(record)).toBe(false);
  });

  it("keeps the record when run again over its own launcher", async () => {
    const { root, home, record } = await installRoot();
    const shim = join(home, ".local", "bin", "pi");

    await symlink("../../.pi/agent/bin/pi", shim);

    expect(runInstall(root).status).toBe(0);

    const again = runInstall(root);

    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("the managed pi at");
    expect(await readFile(record, "utf8")).toBe("../../.pi/agent/bin/pi\n");
    expect(await isLauncherWrapper(shim)).toBe(true);
  });
});

describe("install.sh preflight and shells", { timeout: INSTALL_TIMEOUT_MS }, () => {
  it("refuses to run as root and changes nothing", async () => {
    const { root, home } = await installRoot({ id: "echo 0" });
    const result = runInstall(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run install.sh as your own user, not as root or with sudo");
    expect(await exists(join(home, ".zshrc"))).toBe(false);
  });

  it("refuses a macOS older than the VM type needs", async () => {
    const { root } = await installRoot({ sw_vers: "echo 12.7.4" });
    const result = runInstall(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "macOS 12.7.4 is too old, the sandbox VM (vz with virtiofs) needs macOS 13 or newer",
    );
  });

  it("writes a fish conf.d snippet for a fish login shell, and uninstall removes it", async () => {
    const { root, home } = await installRoot();
    const fish = join(home, ".config", "fish", "conf.d", "pi-sandbox.fish");
    const env = { SHELL: "/opt/homebrew/bin/fish" };
    const result = runInstall(root, [], env);

    expect(result.status).toBe(0);
    expect(await readFile(fish, "utf8")).toBe(
      `\n# pi-sandbox begin\nset -gx PATH '${join(home, ".local", "bin")}' $PATH\n# pi-sandbox end\n`,
    );

    const removed = spawnSync("/bin/sh", [join(launcherRoot(), "uninstall.sh")], {
      env: { HOME: home, PATH: join(root, "tools"), PI_SANDBOX_STATE_DIR: join(root, "state") },
      encoding: "utf8",
    });

    expect(removed.status).toBe(0);
    expect(await exists(fish)).toBe(false);
  });

  it("does not claim another pi is shadowed for a login shell it does not configure", async () => {
    const { root } = await installRoot({ pi: "echo other pi" });
    const result = runInstall(root, [], { SHELL: "/usr/local/bin/nu" });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("is now shadowed");
    expect(result.stdout).toContain(
      `your login shell nu is not configured: put ${join(root, "home", ".local", "bin")} first on PATH in its startup file, or pi keeps running ${join(root, "tools", "pi")} outside the sandbox`,
    );
  });
});

describe("install.sh and the Colima profile", { timeout: INSTALL_TIMEOUT_MS }, () => {
  const STOPPED_COLIMA = [
    'echo "$*" >> "$HOME/colima.log"',
    'case "$1" in version) echo "colima version 0.8.1" ;; status) exit 1 ;; *) exit 0 ;; esac',
  ].join("\n");

  const startOf = async (home: string) =>
    (await readFile(join(home, "colima.log"), "utf8")).split("\n").find((line) => line.startsWith("start "));

  it("shares the home writable when it creates the profile, with 8 CPUs and 10 GiB", async () => {
    const { root, home } = await installRoot({ colima: STOPPED_COLIMA });
    const result = runInstall(root);

    expect(result.status).toBe(0);
    expect(await startOf(home)).toBe(
      `start --profile pi-sandbox --activate=false --vm-type vz --mount-type virtiofs --cpu 8 --memory 10 --disk 60 --mount ${home}:w`,
    );
    expect(result.stdout).toContain(
      `[3/7] colima: starting profile pi-sandbox (vz, virtiofs, 8 CPUs, 10 GiB, 60 GiB, ${home} writable)`,
    );
  });

  const INSTALLING_BREW = [
    'echo "==> Pouring colima"',
    'echo "brew warning" >&2',
    `printf '#!/bin/sh\\ncase "$1" in version) echo "colima version 0.8.1" ;; *) exit 0 ;; esac\\n' > "$(dirname "$0")/colima"`,
    'chmod 0755 "$(dirname "$0")/colima"',
  ].join("\n");

  it("prints the runtime step before brew runs and streams brew's output indented", async () => {
    const { root } = await installRoot({ brew: INSTALLING_BREW });

    await rm(join(root, "tools", "colima"));

    const result = runInstall(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "[2/7] runtime: installing colima with Homebrew\n      ==> Pouring colima\n      brew warning\n",
    );
  });

  it("stops with brew's exit status when brew fails, after showing its output", async () => {
    const { root } = await installRoot({ brew: 'echo "Error: no bottle"\nexit 3' });

    await rm(join(root, "tools", "colima"));

    const result = runInstall(root);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "[2/7] runtime: installing colima with Homebrew\n      Error: no bottle\n",
    );
    expect(result.stdout).not.toContain("[3/7]");
  });

  const sysctl = (cpus: number, bytes: number) =>
    `case "$2" in hw.ncpu) echo ${cpus} ;; hw.memsize) echo ${bytes} ;; *) exit 1 ;; esac`;

  it("sizes the VM to this Mac's CPUs and half its memory, and keeps the size the flags give", async () => {
    const sized = await installRoot({ colima: STOPPED_COLIMA, sysctl: sysctl(4, 16 * 1024 ** 3) });
    const flagged = await installRoot({ colima: STOPPED_COLIMA, sysctl: sysctl(4, 16 * 1024 ** 3) });
    const result = runInstall(sized.root);

    runInstall(flagged.root, ["--cpu", "6", "--memory", "12"]);

    expect(await startOf(sized.home)).toContain("--cpu 4 --memory 8 --disk 60");
    expect(result.stdout).toContain("4 CPUs, 8 GiB, 60 GiB, sized to this Mac, ");
    expect(await startOf(flagged.home)).toContain("--cpu 6 --memory 12 --disk 60");
  });

  it("keeps the saved shares when the profile exists", async () => {
    const { root, home } = await installRoot({ colima: STOPPED_COLIMA });

    await mkdir(join(home, ".colima", "pi-sandbox"), { recursive: true });

    await writeFile(
      join(home, ".colima", "pi-sandbox", "colima.yaml"),
      "mounts:\n  - location: /Volumes/Projects\n",
    );

    const result = runInstall(root);

    expect(result.status).toBe(0);
    expect(await startOf(home)).toBe(
      "start --profile pi-sandbox --activate=false --vm-type vz --mount-type virtiofs --cpu 8 --memory 10 --disk 60",
    );
    expect(result.stdout).toContain("60 GiB, shares kept)");
  });
});

describe("install.sh options and the PATH block", { timeout: INSTALL_TIMEOUT_MS }, () => {
  const zshrc = (home: string) => join(home, ".zshrc");

  it("leaves an rc file with a begin line and no end line as it is, and says so", async () => {
    const { root, home } = await installRoot();
    const text = "alias a=1\n# pi-sandbox begin\nexport KEEP=me\nalias b=2\n";

    await writeFile(zshrc(home), text);

    const first = runInstall(root);
    const second = runInstall(root);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toContain(
      `no PATH snippet added; ${zshrc(home)} has a "# pi-sandbox begin" or "# pi-sandbox end" line without its pair, left as it is`,
    );
    expect(await readFile(zshrc(home), "utf8")).toBe(text);
  });

  it("writes its block once when run again and keeps the lines around it", async () => {
    const { root, home } = await installRoot();

    await writeFile(zshrc(home), "alias a=1\n");

    expect(runInstall(root).status).toBe(0);

    await writeFile(zshrc(home), `${await readFile(zshrc(home), "utf8")}alias b=2\n`);

    const again = runInstall(root);

    expect(again.status).toBe(0);
    expect(again.stdout).toContain("PATH snippet already present");
    expect(await readFile(zshrc(home), "utf8")).toBe(
      `alias a=1\n\n# pi-sandbox begin\nexport PATH='${join(home, ".local", "bin")}':"$PATH"\n# pi-sandbox end\nalias b=2\n`,
    );
  });

  it("quotes a home with $, a backtick, a space and a single quote so the shell takes it literally, and uninstall removes it all again", async () => {
    const { root, home } = await installRoot({}, "h $HOME `touch pwned` it's");
    const binDir = join(home, ".local", "bin");
    const env = {
      HOME: home,
      PATH: join(root, "tools"),
      PI_SANDBOX_STATE_DIR: join(root, "state"),
      PI_SANDBOX_USER_CONFIG: join(root, "config", "config.json"),
      PI_SANDBOX_POLICY_FILE: join(root, "policy.json"),
    };
    const installed = spawnSync("/bin/dash", [join(launcherRoot(), "install.sh")], { env, encoding: "utf8" });

    expect(installed.status).toBe(0);

    const rc = await readFile(zshrc(home), "utf8");
    const sourced = spawnSync("/bin/dash", ["-c", `. "$1"; printf '%s' "$PATH"`, "dash", zshrc(home)], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });

    expect(rc).toContain(`export PATH='${binDir.replace("'", "'\\''")}':"$PATH"\n`);
    expect(sourced.stdout).toBe(`${binDir}:/usr/bin:/bin`);
    expect(await exists(join(root, "pwned"))).toBe(false);
    expect(await isLauncherWrapper(join(binDir, "pi"))).toBe(true);

    const removed = spawnSync("/bin/dash", [join(launcherRoot(), "uninstall.sh")], { env, encoding: "utf8" });

    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain(`launcher: removed ${binDir}/pi\n`);
    expect(await exists(join(binDir, "pi"))).toBe(false);
    expect(await readFile(zshrc(home), "utf8")).toBe("\n");
  });

  it("refuses the removed options and an option without its value", async () => {
    const { root, home } = await installRoot();
    const binDir = runInstall(root, ["--bin-dir", "/opt/bin"]);
    const dryRun = runInstall(root, ["--dry-run"]);
    const missing = runInstall(root, ["--cpu"]);

    expect(binDir.status).toBe(1);
    expect(binDir.stderr).toContain("pi-sandbox install: unknown option --bin-dir\n");
    expect(dryRun.status).toBe(1);
    expect(dryRun.stderr).toContain("pi-sandbox install: unknown option --dry-run\n");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("pi-sandbox install: --cpu needs a value\n");
    expect(await exists(zshrc(home))).toBe(false);
  });

  it("finds its checkout when CDPATH is exported and it is run by a relative path", async () => {
    const { root, home } = await installRoot();
    const checkout = join(launcherRoot(), "..");
    const result = spawnSync("/bin/sh", ["launcher/install.sh"], {
      cwd: checkout,
      env: {
        HOME: home,
        PATH: join(root, "tools"),
        CDPATH: `.:${root}`,
        PI_SANDBOX_STATE_DIR: join(root, "state"),
        PI_SANDBOX_USER_CONFIG: join(root, "config", "config.json"),
        PI_SANDBOX_POLICY_FILE: join(root, "policy.json"),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(await isLauncherWrapper(join(home, ".local", "bin", "pi"))).toBe(true);
  });

  const noManagedPi = (agentDir: string) =>
    `pi-sandbox install: no managed pi in ${agentDir} (a pi installed with npm or found on PATH is not used): the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable; install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) and run this again\n`;

  const writePiPackage = async (dir: string) => {
    const packageDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");

    await mkdir(packageDir, { recursive: true });

    await writeFile(join(packageDir, "package.json"), '{ "version": "1.6.0", "bin": { "pi": "cli.js" } }');
  };

  const withPathPi = async (root: string, calls: string) => {
    await writeFile(join(root, "tools", "pi"), "#!/bin/sh\necho path pi\n");

    await chmod(join(root, "tools", "pi"), 0o755);

    await writeFile(
      join(root, "tools", "colima"),
      `#!/bin/sh\necho "colima $*" >> "${calls}"\ncase "$1" in version) echo "colima version 0.8.1" ;; *) exit 0 ;; esac\n`,
    );
  };

  it("refuses from a published package without a managed pi, even with pi in node_modules or on PATH, before npm or colima run", async () => {
    const { root, home, agentDir } = await installRoot();
    const packaged = join(root, "package", "launcher");
    const npmPrefix = join(root, "npm");
    const calls = join(root, "calls.log");

    await rm(agentDir, { recursive: true, force: true });

    await mkdir(join(packaged, "bin"), { recursive: true });

    await writeFile(join(packaged, "install.sh"), await readFile(join(launcherRoot(), "install.sh"), "utf8"));

    await writeFile(
      join(root, "package", "package.json"),
      '{\n  "name": "pi-extensions-mz",\n  "version": "9.9.9"\n}\n',
    );

    await Promise.all(
      ["path-block.sh", "paths.sh"].map(async (name) =>
        writeFile(join(packaged, "bin", name), await readFile(join(launcherRoot(), "bin", name), "utf8")),
      ),
    );

    await writeFile(
      join(root, "tools", "npm"),
      `#!/bin/sh\necho "npm $*" >> "${calls}"\ncase "$1" in root) echo "${npmPrefix}/lib/node_modules" ;; prefix) echo "${npmPrefix}" ;; esac\n`,
    );

    await writePiPackage(join(root, "package"));

    await writePiPackage(join(npmPrefix, "lib"));

    await withPathPi(root, calls);

    const result = spawnSync("/bin/sh", [join(packaged, "install.sh")], {
      env: {
        HOME: home,
        PATH: join(root, "tools"),
        PI_SANDBOX_STATE_DIR: join(root, "state"),
        PI_SANDBOX_USER_CONFIG: join(root, "config", "config.json"),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(noManagedPi(agentDir));
    expect(await readFile(calls, "utf8").catch(() => "")).not.toMatch(/npm install|colima start/);
    expect(await exists(join(home, ".local", "bin", "pi"))).toBe(false);
    expect(await exists(zshrc(home))).toBe(false);
  });

  it("refuses from a checkout without a managed pi, though the checkout's node_modules holds pi", async () => {
    const { root, home, agentDir } = await installRoot();
    const calls = join(root, "calls.log");

    await rm(agentDir, { recursive: true, force: true });

    await withPathPi(root, calls);

    const result = runInstall(root);

    expect(
      await exists(join(launcherRoot(), "..", "node_modules", "@earendil-works", "pi-coding-agent")),
    ).toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(noManagedPi(agentDir));
    expect(await readFile(calls, "utf8").catch(() => "")).not.toContain("colima start");
    expect(await exists(join(home, ".local", "bin", "pi"))).toBe(false);
    expect(await exists(zshrc(home))).toBe(false);
  });
});
