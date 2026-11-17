import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launcherRoot } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";
import { writeManagedPi } from "./harness.ts";

export const SYSTEM_TOOLS = [
  "awk",
  "cat",
  "chmod",
  "dirname",
  "grep",
  "head",
  "ln",
  "mkdir",
  "mktemp",
  "readlink",
  "rm",
  "rmdir",
  "sed",
  "tee",
];

export const FAKES: Record<string, string> = {
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
    ...SYSTEM_TOOLS.filter((name) => fakes[name] === undefined).map((name) =>
      symlink(toolPath(name), join(dir, name)),
    ),
    ...(fakes.node === undefined ? [symlink(process.execPath, join(dir, "node"))] : []),
    ...Object.entries(fakes).map(async ([name, body]) => {
      await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);

      await chmod(join(dir, name), 0o755);
    }),
  ]);
};

export const installRoot = async (fakes: Record<string, string> = {}, homeName = "home") => {
  const root = await realpath(await tempDir("install"));
  const home = join(root, homeName);
  const agentDir = join(home, ".pi", "agent");

  await writeTools(join(root, "tools"), { ...FAKES, ...fakes });

  await mkdir(join(home, ".local", "bin"), { recursive: true });

  const managed = await writeManagedPi(agentDir, "1.6.0");

  return { root, home, agentDir, managed, record: join(root, "state", "replaced-pi-link") };
};

export const INSTALL_TIMEOUT_MS = 30_000;

export const packageVersion = async () =>
  (JSON.parse(await readFile(join(launcherRoot(), "..", "package.json"), "utf8")) as { version: string })
    .version;

export const runInstall = (
  root: string,
  flags: string[] = [],
  extraEnv: Record<string, string> = {},
  script = join(launcherRoot(), "install.sh"),
  input = "",
) =>
  spawnSync("/bin/sh", [script, ...flags], {
    input,
    env: {
      ...extraEnv,
      HOME: join(root, "home"),
      PATH: join(root, "tools"),
      PI_SANDBOX_STATE_DIR: join(root, "state"),
      PI_SANDBOX_USER_CONFIG: join(root, "config", "config.json"),
    },
    encoding: "utf8",
  });

export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
