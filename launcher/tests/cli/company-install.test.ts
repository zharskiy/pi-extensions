import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const EXAMPLE = join(launcherRoot(), "examples", "org", "company-install.sh");

const FAKE_CURL = `
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  *"$FAIL_URL") exit 22 ;;
  */install.sh) cp "$HOME/../bootstrap.sh" "$out" ;;
  */SHA256SUMS) cp "$HOME/../SHA256SUMS" "$out" ;;
esac
`;

const setup = async (bootstrap: string) => {
  const root = await realpath(await tempDir("company-install"));
  const tools = join(root, "tools");
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");

  await mkdir(tools, { recursive: true });

  await mkdir(agentDir, { recursive: true });

  await writeFile(join(tools, "curl"), `#!/bin/sh\n${FAKE_CURL}`);

  await chmod(join(tools, "curl"), 0o755);

  await writeFile(join(root, "bootstrap.sh"), bootstrap);

  const digest = createHash("sha256").update(bootstrap).digest("hex");

  await writeFile(join(root, "SHA256SUMS"), `${digest}  install.sh\n`);

  return { root, home, agentDir, tools };
};

const runExample = (paths: { root: string; home: string; tools: string }, env: Record<string, string> = {}) =>
  spawnSync("/bin/sh", [EXAMPLE], {
    env: {
      HOME: paths.home,
      PATH: `${paths.tools}:${dirname(process.execPath)}:/usr/bin:/bin`,
      PI_SANDBOX_ROOTS: `${paths.root}/a:${paths.root}/b c`,
      FAIL_URL: "none",
      ...env,
    },
    encoding: "utf8",
  });

describe("the example company-install.sh", { timeout: 30_000 }, () => {
  it("passes the pin, the org config and every root to the verified bootstrap and keeps its exit code", async () => {
    const paths = await setup('printf "%s\\n" "$@" > "$HOME/../args"\nexit 75\n');
    const result = runExample(paths);

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("company-install: bootstrap: pi is running, nothing was changed");
    expect((await readFile(join(paths.root, "args"), "utf8")).split("\n")).toEqual([
      "--package-version",
      expect.stringMatching(/^\d+\.\d+\.\d+$/),
      "--config",
      join(launcherRoot(), "examples", "org", "config.json"),
      "--config-conflict",
      "keep",
      "--root",
      `${paths.root}/a`,
      "--root",
      `${paths.root}/b c`,
      "",
    ]);
  });

  it("names a failed download as a download failure, not as a checksum mismatch", async () => {
    const paths = await setup("exit 0\n");
    const install = runExample(paths, { FAIL_URL: "/install.sh" });
    const sums = runExample(paths, { FAIL_URL: "/SHA256SUMS" });

    expect(install.status).toBe(70);
    expect(install.stderr).toMatch(
      /company-install: download: downloading \S+\/install\.sh failed \(curl exit 22\)/,
    );
    expect(install.stderr).not.toContain("SHA256SUMS of");
    expect(sums.status).toBe(70);
    expect(sums.stderr).toMatch(
      /company-install: download: downloading \S+\/SHA256SUMS failed \(curl exit 22\)/,
    );
  });

  it("refuses a bootstrap that does not match SHA256SUMS and does not run it", async () => {
    const paths = await setup('touch "$HOME/../ran"\n');

    await writeFile(join(paths.root, "bootstrap.sh"), 'touch "$HOME/../ran"\n# changed\n');

    const result = runExample(paths);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("company-install: checksum: install.sh does not match SHA256SUMS");
    expect(spawnSync("test", ["-e", join(paths.root, "ran")]).status).toBe(1);
  });

  it("keeps the user's settings, sets only the enforced keys over them, and adds the missing ones", async () => {
    const paths = await setup("exit 0\n");
    const settings = join(paths.agentDir, "settings.json");

    await writeFile(
      settings,
      JSON.stringify({ quietStartup: true, selfUpdateCommand: ["mine"], packages: ["npm:x@1.0.0"] }),
    );

    expect(runExample(paths).status).toBe(0);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({
      quietStartup: true,
      selfUpdateCommand: ["/usr/local/libexec/example-corp/company-update.sh", "{version}"],
      packages: ["npm:x@1.0.0"],
      collapseChangelog: false,
    });
  });

  it("maps a bootstrap exit code it does not know to 70", async () => {
    const paths = await setup("exit 5\n");
    const result = runExample(paths);

    expect(result.status).toBe(70);
    expect(result.stderr).toContain("company-install: bootstrap: the bootstrap exited with 5");
  });
});
