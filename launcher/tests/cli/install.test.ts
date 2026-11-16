import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";
import { exists, tempDir } from "../support/temp-dir.ts";
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
  "tee",
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

const FAKE_INIT = [
  'if [ "$2" = sandbox ] && [ "$3" = init ]; then',
  "  if [ -t 0 ]; then stdin=terminal; else stdin=other; fi",
  '  printf "%s %s\\n" "$*" "$stdin" >> "$HOME/../init-calls"',
  '  code="$FAKE_INIT_EXIT"; if [ -z "$code" ]; then code=0; fi',
  '  echo "init said $code"',
  '  exit "$code"',
  "fi",
  `exec '${process.execPath}' "$@"`,
].join("\n");

const writeTools = async (dir: string, fakes: Record<string, string>) => {
  await mkdir(dir, { recursive: true });

  await Promise.all([
    ...SYSTEM_TOOLS.map((name) => symlink(toolPath(name), join(dir, name))),
    ...Object.entries({ node: FAKE_INIT, ...fakes }).map(async ([name, body]) => {
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

const WITHOUT_TERMINAL = { detached: true };

const installEnv = (root: string, extraEnv: Record<string, string> = {}) => ({
  ...extraEnv,
  HOME: join(root, "home"),
  PATH: join(root, "tools"),
  PI_SANDBOX_STATE_DIR: join(root, "state"),
  PI_SANDBOX_USER_CONFIG: join(root, "config", "config.json"),
});

const runInstall = (root: string, flags: string[] = [], extraEnv: Record<string, string> = {}) =>
  spawnSync("/bin/sh", [join(launcherRoot(), "install.sh"), ...flags], {
    ...WITHOUT_TERMINAL,
    env: installEnv(root, extraEnv),
    encoding: "utf8",
  });

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
    expect(result.stdout).toContain("[5/6] smoke: skipped, git is missing");
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

describe("install.sh and Homebrew", { timeout: INSTALL_TIMEOUT_MS }, () => {
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
      "[2/6] runtime: installing colima with Homebrew\n      ==> Pouring colima\n      brew warning\n",
    );
  });

  it("stops with brew's exit status when brew fails, after showing its output", async () => {
    const { root } = await installRoot({ brew: 'echo "Error: no bottle"\nexit 3' });

    await rm(join(root, "tools", "colima"));

    const result = runInstall(root);

    expect(result.status).toBe(3);
    expect(result.stdout).toContain(
      "[2/6] runtime: installing colima with Homebrew\n      Error: no bottle\n",
    );
    expect(result.stdout).not.toContain("[3/6]");
  });
});

describe("install.sh and pi sandbox init", { timeout: INSTALL_TIMEOUT_MS }, () => {
  const initCalls = async (root: string) =>
    (await readFile(join(root, "init-calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line !== "");

  it("runs pi sandbox init --yes without a terminal, indents its lines and goes on", async () => {
    const { root } = await installRoot();
    const result = runInstall(root);

    expect(result.status).toBe(0);
    expect(await initCalls(root)).toEqual([
      expect.stringMatching(/pi-sandbox-dev\.js sandbox init --yes other$/),
    ]);
    expect(result.stdout).toContain(
      "[4/6] setup: running pi sandbox init\n      init said 0\n[4/6] setup: done\n[5/6] smoke:",
    );
  });

  it.runIf(process.platform === "darwin")(
    "runs pi sandbox init on the terminal, unindented, when there is one",
    async () => {
      const { root } = await installRoot();
      const result = spawnSync(
        "/usr/bin/script",
        ["-q", "/dev/null", "/bin/sh", join(launcherRoot(), "install.sh")],
        {
          env: installEnv(root),
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(await initCalls(root)).toEqual([
        expect.stringMatching(/pi-sandbox-dev\.js sandbox init terminal$/),
      ]);
      expect(result.stdout).toContain(
        "[4/6] setup: running pi sandbox init\r\ninit said 0\r\n[4/6] setup: done",
      );
    },
  );

  it("asks nothing when CI is set", async () => {
    const { root } = await installRoot();

    expect(runInstall(root, [], { CI: "true" }).status).toBe(0);
    expect(await initCalls(root)).toEqual([expect.stringMatching(/sandbox init --yes other$/)]);
  });

  it("stops with 130 and no smoke check when the setup is cancelled", async () => {
    const { root } = await installRoot();
    const result = runInstall(root, [], { FAKE_INIT_EXIT: "130" });

    expect(result.status).toBe(130);
    expect(result.stderr).toBe(
      "pi-sandbox install: setup cancelled; the launcher is installed, run pi sandbox init to finish\n",
    );
    expect(result.stdout).not.toContain("[5/6]");
  });

  it("stops with the setup's status when it fails", async () => {
    const { root } = await installRoot();
    const result = runInstall(root, [], { FAKE_INIT_EXIT: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "pi-sandbox install: setup failed, see above; the launcher is installed, run pi sandbox init to try again\n",
    );
    expect(result.stdout).not.toContain("[4/6] setup: done");
    expect(result.stdout).not.toContain("[5/6]");
  });

  it("starts no VM itself", async () => {
    const { root, home } = await installRoot({
      colima:
        'echo "$*" >> "$HOME/colima.log"\ncase "$1" in version) echo "colima version 0.8.1" ;; *) exit 1 ;; esac',
    });

    expect(runInstall(root).status).toBe(0);
    expect(await readFile(join(home, "colima.log"), "utf8")).toBe("version\n");
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

  it("refuses unknown options", async () => {
    const { root, home } = await installRoot();
    const binDir = runInstall(root, ["--bin-dir", "/opt/bin"]);
    const dryRun = runInstall(root, ["--dry-run"]);

    expect(binDir.status).toBe(1);
    expect(binDir.stderr).toContain("pi-sandbox install: unknown option --bin-dir\n");
    expect(dryRun.status).toBe(1);
    expect(dryRun.stderr).toContain("pi-sandbox install: unknown option --dry-run\n");
    expect(await exists(zshrc(home))).toBe(false);
  });

  it("refuses the removed sizing and root options with their replacement, before any change", async () => {
    const { root, home } = await installRoot();
    const config = join(root, "config", "config.json");
    const sizing = `pi-sandbox install: --cpu, --memory and --disk were removed: the installer asks for the VM size; without a terminal, set vm.cpus, vm.memoryGiB and vm.diskGiB in ${config} first\n`;
    const roots =
      "pi-sandbox install: --root was removed: the installer asks for your project folders; without a terminal, set PI_SANDBOX_ROOTS\n";
    const results = [["--cpu", "6"], ["--memory=12"], ["--disk"], ["--root", "/work"], ["--root="]].map(
      (flags) => runInstall(root, flags),
    );

    expect(results.map((result) => [result.status, result.stderr])).toEqual([
      [1, sizing],
      [1, sizing],
      [1, sizing],
      [1, roots],
      [1, roots],
    ]);
    expect(await exists(zshrc(home))).toBe(false);
    expect(await exists(join(home, ".local", "bin", "pi"))).toBe(false);
    expect(await exists(config)).toBe(false);
  });

  it("prints its usage", async () => {
    const { root } = await installRoot();
    const result = runInstall(root, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("usage: install.sh\n");
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
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(await isLauncherWrapper(join(home, ".local", "bin", "pi"))).toBe(true);
  });

  const noManagedPi = (agentDir: string) =>
    `pi-sandbox install: no managed pi in ${agentDir} (a pi installed with npm or found on PATH is not used): the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable; install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) and run this again\n`;

  it("refuses without a managed pi, though pi is on PATH and in the checkout's node_modules, before npm or colima run", async () => {
    const { root, home, agentDir } = await installRoot({
      pi: "echo path pi",
      npm: 'echo "npm $*" >> "$HOME/../calls.log"',
      colima:
        'echo "colima $*" >> "$HOME/../calls.log"\ncase "$1" in version) echo "colima version 0.8.1" ;; *) exit 0 ;; esac',
    });
    const calls = join(root, "calls.log");

    await rm(agentDir, { recursive: true, force: true });

    const result = runInstall(root);

    expect(
      await exists(join(launcherRoot(), "..", "node_modules", "@earendil-works", "pi-coding-agent")),
    ).toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(noManagedPi(agentDir));
    expect(await readFile(calls, "utf8").catch(() => "")).not.toMatch(/npm install|colima start/);
    expect(await exists(join(home, ".local", "bin", "pi"))).toBe(false);
    expect(await exists(zshrc(home))).toBe(false);
  });
});

describe("install.sh and the smoke folder", { timeout: INSTALL_TIMEOUT_MS }, () => {
  const configFile = (root: string) => join(root, "config", "config.json");

  const rootsSetup = async (
    fakes: Record<string, string> = {},
    roots: (setup: { home: string; root: string }) => string[] = () => [],
  ) => {
    const setup = await installRoot(fakes);
    const work = join(setup.root, "my work");

    await mkdir(work, { recursive: true });

    const configured = roots(setup);

    if (configured.length > 0) {
      await mkdir(join(setup.root, "config"), { recursive: true });

      await writeFile(configFile(setup.root), JSON.stringify({ workspaceRoots: { roots: configured } }));
    }

    return { ...setup, work };
  };

  it("runs the smoke check in a temporary repository under ~/.cache when the VM shares the home", async () => {
    const { root, home } = await rootsSetup({ git: 'echo "$2" >> "$HOME/../git-dirs"\nexit 1' });
    const result = runInstall(root);
    const smokeDir = (await readFile(join(root, "git-dirs"), "utf8")).trim();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("sandbox doctor in a temporary git repository; the first image build");
    expect(dirname(smokeDir)).toBe(join(home, ".cache"));
  });

  it("stops before the smoke check when __vm-shares fails on the config", async () => {
    const { root } = await rootsSetup({}, ({ home }) => [home]);
    const result = runInstall(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pi-sandbox: config: workspaceRoots.roots:");
    expect(result.stdout).not.toContain("[5/6]");
  });

  it("keeps a backslash in a root path when it picks the smoke folder", async () => {
    const { root } = await rootsSetup({ git: "exit 1" }, ({ root }) => [join(root, "back\\tslash")]);

    await mkdir(join(root, "back\\tslash"));

    const result = runInstall(root);

    expect(result.stdout).toContain(
      `sandbox doctor in a temporary git repository in ${join(root, "back\\tslash")};`,
    );
  });

  it("skips the smoke check when none of the workspace roots exists", async () => {
    const { root } = await rootsSetup({ git: "exit 1" }, ({ root }) => [join(root, "gone")]);
    const result = runInstall(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "[5/6] smoke: skipped, none of the workspace roots exists; run pi sandbox doctor inside a repository in one of them",
    );
  });

  it("says the sandbox part of the smoke check was skipped when the VM does not share the root yet", async () => {
    const { root, work } = await rootsSetup({ git: "exit 0" }, ({ root }) => [join(root, "my work")]);
    const node = join(root, "tools", "node");

    await rm(node);

    await writeFile(
      node,
      [
        "#!/bin/sh",
        'if [ "$2" = sandbox ] && [ "$3" = doctor ]; then',
        '  echo "  skip  sandbox  not started until the VM shares $PWD"',
        "  exit 0",
        "fi",
        'if [ "$2" = sandbox ]; then exit 0; fi',
        `exec '${process.execPath}' "$@"`,
      ].join("\n"),
    );

    await chmod(node, 0o755);

    const result = runInstall(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not started until the VM shares");
    expect(result.stdout).toContain(
      `sandbox doctor passed the host checks; the sandbox part was skipped because the VM does not share ${work} yet, and runs at the first pi launch`,
    );
    expect(result.stdout).not.toContain("sandbox doctor passed\n");
  });

  it("runs the smoke check in a folder inside the first root that exists and removes it", async () => {
    const { root, work } = await rootsSetup(
      { git: 'echo "$2" >> "$HOME/../git-dirs"\nexit 1' },
      ({ root }) => [join(root, "gone"), join(root, "my work")],
    );
    const result = runInstall(root);
    const smokeDir = (await readFile(join(root, "git-dirs"), "utf8")).trim();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`sandbox doctor in a temporary git repository in ${work};`);
    expect(dirname(smokeDir)).toBe(work);
    expect(await exists(smokeDir)).toBe(false);
  });
});
