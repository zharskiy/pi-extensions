import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEffectiveConfig } from "../../config/index.ts";
import { forwardedEnv } from "../../container/index.ts";
import { launcherRoot } from "../../shared/index.ts";

const BASH_ENV_FILE = join(launcherRoot(), "image", "bash-env.sh");

const HINT =
  "bash: pi-sandbox-missing-tool: command not found\npi-sandbox: pi-sandbox-missing-tool is not in the sandbox image; add it with image.packages or image.npmGlobal in ~/.config/pi-sandbox/config.json (see pi sandbox doctor)\n";

const bashVersion = spawnSync("bash", ["--version"], { encoding: "utf8" }).stdout ?? "";

const bashMajor = Number(/version (\d+)\./.exec(bashVersion)?.[1] ?? 0);

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const loadUserConfig = async (value: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-bash-env-"));
  const userConfig = join(root, "config.json");

  dirs.push(root);

  await writeFile(userConfig, JSON.stringify(value));

  return loadEffectiveConfig({
    repoRoot: root,
    home: root,
    offline: true,
    env: { PI_SANDBOX_USER_CONFIG: userConfig, PI_SANDBOX_POLICY_FILE: join(root, "policy.json") },
  });
};

describe("the missing-command hint", () => {
  it.skipIf(!(bashMajor >= 4))(
    "names the command and the config keys on stderr and exits 127 under bash -c",
    () => {
      const result = spawnSync("bash", ["-c", "pi-sandbox-missing-tool --version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, BASH_ENV: BASH_ENV_FILE },
      });

      expect(result.stderr).toBe(HINT);
      expect(result.stdout).toBe("");
      expect(result.status).toBe(127);
    },
  );

  it.skipIf(!(bashMajor >= 4))("leaves commands that exist alone", () => {
    const result = spawnSync("bash", ["-c", "echo found"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, BASH_ENV: BASH_ENV_FILE },
    });

    expect(result.stdout).toBe("found\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("BASH_ENV is set by the launcher's image", () => {
  it("is refused in env.allow", async () => {
    await expect(loadUserConfig({ env: { allow: ["EDITOR", "BASH_ENV"] } })).rejects.toThrow(
      "user: env.allow[1] BASH_ENV is set by the launcher and is not forwarded",
    );
  });

  it("leaves other names in env.allow alone", async () => {
    const loaded = await loadUserConfig({ env: { allow: ["EDITOR"] } });

    expect(loaded.config.env.allow).toContain("EDITOR");
  });

  it("is never forwarded from the host", () => {
    expect(forwardedEnv(["BASH_ENV", "EDITOR"], { BASH_ENV: "/host/rc", EDITOR: "vi" })).toEqual({
      EDITOR: "vi",
    });
  });
});
