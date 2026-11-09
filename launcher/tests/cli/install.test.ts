import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";
import { writeManagedPi } from "./harness.ts";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

const installRoot = async (fakes: Record<string, string> = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-install-")));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");

  created.push(root);

  await writeTools(join(root, "tools"), { ...FAKES, ...fakes });

  await mkdir(join(home, ".local", "bin"), { recursive: true });

  const managed = await writeManagedPi(agentDir, "1.6.0");

  return { root, home, agentDir, managed, record: join(root, "state", "replaced-pi-link") };
};

const runInstall = (root: string, flags: string[] = []) =>
  spawnSync("/bin/sh", [join(launcherRoot(), "install.sh"), ...flags], {
    env: {
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

describe("install.sh and pi's managed install", () => {
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
    expect(result.stdout).toContain("[7/8] smoke: skipped, git is missing");
    expect(await readFile(record, "utf8")).toBe(`${shim}\n../lib/pi-link\n`);
    expect(await isLauncherWrapper(shim)).toBe(true);
  });

  it("refuses a pi that is neither the launcher nor pi's managed install, and records nothing", async () => {
    const { root, home, record } = await installRoot();
    const shim = join(home, ".local", "bin", "pi");

    await writeFile(shim, "#!/bin/sh\necho mine\n");

    const result = runInstall(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${shim} exists and is not the pi-sandbox launcher, move it away or pass --bin-dir`,
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
      `${shim} is pi's managed install at ${elsewhere}, outside the host agent dir ${join(home, ".pi", "agent")}; the launcher uses only the managed install in the agent dir, move it away or pass --bin-dir`,
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
    expect(await readFile(record, "utf8")).toBe(`${shim}\n../../.pi/agent/bin/pi\n`);
    expect(await isLauncherWrapper(shim)).toBe(true);
  });

  it("records the shim of --bin-dir at its real path and refuses another shim while that record stands", async () => {
    const { root, home, managed, record } = await installRoot();
    const binDir = join(root, "custom-bin");
    const shim = join(binDir, "pi");
    const defaultShim = join(home, ".local", "bin", "pi");

    await mkdir(binDir, { recursive: true });

    await symlink(binDir, join(root, "custom-bin-alias"));

    await symlink(managed.wrapper, shim);

    expect(runInstall(root, ["--bin-dir", join(root, "custom-bin-alias")]).status).toBe(0);
    expect(await readFile(record, "utf8")).toBe(`${shim}\n${managed.wrapper}\n`);

    await symlink(managed.wrapper, defaultShim);

    const other = runInstall(root);

    expect(other.status).toBe(1);
    expect(other.stderr).toContain(
      `${record} records the replaced pi link of ${shim}, not ${defaultShim}; run uninstall.sh --bin-dir ${binDir} first`,
    );
    expect(await readlink(defaultShim)).toBe(managed.wrapper);
  });
});

describe("install.sh and the Colima profile", () => {
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
      `[3/8] colima: started profile pi-sandbox (vz, virtiofs, 8 CPUs, 10 GiB, 60 GiB, ${home} writable)`,
    );
  });

  const sysctl = (cpus: number, bytes: number) =>
    `case "$2" in hw.ncpu) echo ${cpus} ;; hw.memsize) echo ${bytes} ;; *) exit 1 ;; esac`;

  it("lowers the VM size to this Mac's CPUs and half its memory", async () => {
    const { root, home } = await installRoot({ colima: STOPPED_COLIMA, sysctl: sysctl(4, 16 * 1024 ** 3) });
    const result = runInstall(root);

    expect(await startOf(home)).toContain("--cpu 4 --memory 8 --disk 60");
    expect(result.stdout).toContain("4 CPUs, 8 GiB, 60 GiB, sized to this Mac, ");
  });

  it("never sizes the VM below 2 CPUs and 4 GiB, and keeps the size the flags give", async () => {
    const small = await installRoot({ colima: STOPPED_COLIMA, sysctl: sysctl(1, 4 * 1024 ** 3) });
    const flagged = await installRoot({ colima: STOPPED_COLIMA, sysctl: sysctl(4, 16 * 1024 ** 3) });

    runInstall(small.root);

    runInstall(flagged.root, ["--cpu", "6", "--memory", "12"]);

    expect(await startOf(small.home)).toContain("--cpu 2 --memory 4 --disk 60");
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
