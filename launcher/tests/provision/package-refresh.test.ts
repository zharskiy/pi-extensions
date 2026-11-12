import { access, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncVolumeFiles } from "../../provision/index.ts";
import { readJsonObject, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir, writeText } from "./fixtures.ts";

const COMMIT_A = "a".repeat(40);

const COMMIT_B = "b".repeat(40);

const REMOVE_DIRS_SCRIPT = 'rm -rf -- "$@"';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const setup = async () => {
  const stateDir = await tempDir("packages-state");
  const repoRoot = await tempDir("packages-repo");
  const hostAgentDir = await tempDir("packages-host");
  const guestAgentDir = await tempDir("packages-volume");
  const fake = createFakeBackend({ guestAgentDir });
  const containerId = await runningContainer(fake.backend);
  const live = { others: false };
  const sync = async (packages: unknown[], refreshPackages = true) => {
    await writeText(join(hostAgentDir, "settings.json"), JSON.stringify({ packages }));

    return syncVolumeFiles({
      backend: fake.backend,
      containerId,
      stateDir,
      repoHash: "repo1",
      hostAgentDir,
      repoRoot,
      refreshPackages,
      othersLive: () => Promise.resolve(live.others),
    });
  };
  const hostNpm = (name: string, version: string) =>
    writeText(
      join(hostAgentDir, "npm", "node_modules", name, "package.json"),
      JSON.stringify({ name, version }),
    );
  const hostGit = async (path: string, commit: string) => {
    const gitDir = join(hostAgentDir, "git", path, ".git");

    await writeText(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

    await writeText(join(gitDir, "refs", "heads", "main"), `${commit}\n`);
  };
  const volumeCheckout = async (path: string) => {
    const dir = join(guestAgentDir, "git", path);

    await mkdir(dir, { recursive: true });

    await writeText(join(dir, "index.ts"), "old");

    return dir;
  };
  const volumeSettings = async () => JSON.parse((await fake.guestFile("settings.json")) ?? "{}");
  const stampPath = stateLayout(stateDir).repo("repo1").syncPackages;
  const stamp = () => readJsonObject(stampPath);
  const removals = () => fake.execs.filter((exec) => exec.spec.command[2] === REMOVE_DIRS_SCRIPT);

  return {
    sync,
    hostNpm,
    hostGit,
    volumeCheckout,
    volumeSettings,
    stamp,
    stampPath,
    removals,
    repoRoot,
    guestAgentDir,
    hostAgentDir,
    live,
  };
};

describe("sandbox packages follow the host", () => {
  it("pins npm and git packages to the host versions and clears git checkouts on the first launch", async () => {
    const env = await setup();

    await env.hostNpm("@scope/tool", "1.2.3");

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    const checkout = await env.volumeCheckout("github.com/owner/repo");
    const result = await env.sync([
      "npm:@scope/tool",
      { source: "git:github.com/owner/repo@main", extensions: ["a.ts"] },
    ]);

    expect(result.notices).toEqual([]);
    expect((await env.volumeSettings()).packages).toEqual([
      "npm:@scope/tool@1.2.3",
      { source: `git:github.com/owner/repo@${COMMIT_A}`, extensions: ["a.ts"] },
    ]);
    expect(await exists(checkout)).toBe(false);
    expect(await env.stamp()).toEqual({ "npm:@scope/tool": "1.2.3", "git:github.com/owner/repo": COMMIT_A });
  });

  it("does no work when the host packages did not change", async () => {
    const env = await setup();

    await env.hostNpm("tool", "1.0.0");

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["npm:tool", "git:github.com/owner/repo"]);

    const checkout = await env.volumeCheckout("github.com/owner/repo");
    const removalsBefore = env.removals().length;
    const result = await env.sync(["npm:tool", "git:github.com/owner/repo"]);

    expect(result.notices).toEqual([]);
    expect(env.removals()).toHaveLength(removalsBefore);
    expect(await exists(checkout)).toBe(true);
  });

  it("reinstalls changed packages with one notice", async () => {
    const env = await setup();

    await env.hostNpm("tool", "1.0.0");

    await env.hostNpm("same", "3.0.0");

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["npm:tool", "npm:same", "https://github.com/owner/repo.git"]);

    const checkout = await env.volumeCheckout("github.com/owner/repo");

    await env.hostNpm("tool", "1.1.0");

    await env.hostGit("github.com/owner/repo", COMMIT_B);

    const result = await env.sync(["npm:tool", "npm:same", "https://github.com/owner/repo.git"]);

    expect(result.notices).toEqual(["sandbox packages follow the host: reinstalling 2 packages"]);
    expect((await env.volumeSettings()).packages).toEqual([
      "npm:tool@1.1.0",
      "npm:same@3.0.0",
      `https://github.com/owner/repo.git@${COMMIT_B}`,
    ]);
    expect(await exists(checkout)).toBe(false);
  });

  it("forgets a package removed on the host without reinstalling anything", async () => {
    const env = await setup();

    await env.hostNpm("tool", "1.0.0");

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["npm:tool", "git:github.com/owner/repo"]);

    const checkout = await env.volumeCheckout("github.com/owner/repo");
    const removalsBefore = env.removals().length;
    const result = await env.sync(["npm:tool"]);

    expect(result.notices).toEqual([]);
    expect(env.removals()).toHaveLength(removalsBefore);
    expect(await exists(checkout)).toBe(true);
    expect(await env.stamp()).toEqual({ "npm:tool": "1.0.0" });
  });

  it("keeps sources the host has not installed and local paths as they are", async () => {
    const env = await setup();
    const local = join(env.repoRoot, "local-pkg");
    const result = await env.sync(["npm:missing@^2", "git:github.com/owner/absent", local]);

    expect(result.notices).toEqual([]);
    expect((await env.volumeSettings()).packages).toEqual([
      "npm:missing@^2",
      "git:github.com/owner/absent",
      local,
    ]);
  });

  it("replaces the ref of scp-like and ssh git sources and reads packed refs", async () => {
    const env = await setup();
    const gitDir = join(env.hostAgentDir, "git", "gitlab.example.com", "group", "tool", ".git");

    await writeText(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

    await writeText(join(gitDir, "packed-refs"), `# pack-refs with: peeled\n${COMMIT_B} refs/heads/main\n`);

    await env.hostGit("example.org/team/ext", COMMIT_A);

    await env.sync(["git:git@gitlab.example.com:group/tool@v1", "ssh://git@example.org/team/ext"]);

    expect((await env.volumeSettings()).packages).toEqual([
      `git:git@gitlab.example.com:group/tool@${COMMIT_B}`,
      `ssh://git@example.org/team/ext@${COMMIT_A}`,
    ]);
  });

  it("pins at the end of a launch without clearing or recording anything", async () => {
    const env = await setup();

    await env.hostNpm("tool", "1.0.0");

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["npm:tool", "git:github.com/owner/repo"]);

    const checkout = await env.volumeCheckout("github.com/owner/repo");

    await env.hostGit("github.com/owner/repo", COMMIT_B);

    const result = await env.sync(["npm:tool", "git:github.com/owner/repo"], false);

    expect(result.notices).toEqual([]);
    expect((await env.volumeSettings()).packages).toEqual([
      "npm:tool@1.0.0",
      `git:github.com/owner/repo@${COMMIT_B}`,
    ]);
    expect(await exists(checkout)).toBe(true);
    expect(await env.stamp()).toEqual({ "npm:tool": "1.0.0", "git:github.com/owner/repo": COMMIT_A });
  });

  it("warns and retries at the next launch when the outdated checkouts cannot be removed", async () => {
    const env = await setup();

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.volumeCheckout("github.com/owner/repo");

    const lockedParent = join(env.guestAgentDir, "git", "github.com", "owner");

    await chmod(lockedParent, 0o500);

    const result = await env.sync(["git:github.com/owner/repo"]).finally(() => chmod(lockedParent, 0o700));

    expect(result.notices).toEqual([
      "warning: the sandbox packages were not refreshed to follow the host: could not remove the outdated packages from the sandbox volume (exit 1)",
    ]);
    expect(await env.stamp()).toBeUndefined();
    expect((await env.volumeSettings()).packages).toEqual([`git:github.com/owner/repo@${COMMIT_A}`]);
  });

  it("treats a garbled record as a first launch", async () => {
    const env = await setup();

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["git:github.com/owner/repo"]);

    await writeText(env.stampPath, "{ broken");

    const checkout = await env.volumeCheckout("github.com/owner/repo");
    const result = await env.sync(["git:github.com/owner/repo"]);

    expect(result.notices).toEqual([]);
    expect(await exists(checkout)).toBe(false);
    expect(await env.stamp()).toEqual({ "git:github.com/owner/repo": COMMIT_A });
  });

  it("leaves git checkouts and the record alone while another session of the folder runs", async () => {
    const env = await setup();

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["git:github.com/owner/repo"]);

    const checkout = await env.volumeCheckout("github.com/owner/repo");

    await env.hostGit("github.com/owner/repo", COMMIT_B);

    env.live.others = true;

    const deferred = await env.sync(["git:github.com/owner/repo"]);

    expect(deferred.notices).toEqual([
      "sandbox packages follow the host: git packages refresh at the next launch (another session is running)",
    ]);
    expect((await env.volumeSettings()).packages).toEqual([`git:github.com/owner/repo@${COMMIT_B}`]);
    expect(await exists(checkout)).toBe(true);
    expect(await env.stamp()).toEqual({ "git:github.com/owner/repo": COMMIT_A });

    env.live.others = false;

    const retried = await env.sync(["git:github.com/owner/repo"]);

    expect(retried.notices).toEqual(["sandbox packages follow the host: reinstalling 1 package"]);
    expect(await exists(checkout)).toBe(false);
  });

  it("never removes a path outside the volume git dir for a traversal or odd source", async () => {
    const env = await setup();
    const sources = [
      "git:github.com/../../sessions",
      "git:github.com/owner/../../../auth",
      "https://example.org/owner/%2e%2e/x",
      "git:git@example.org:/abs/path",
      "git:example.org/owner//repo",
      "git:example.org/own er/repo",
    ];

    await Promise.all(
      ["github.com/../../sessions", "example.org/owner/%2e%2e/x", "example.org/own er/repo"].map((path) =>
        env.hostGit(path, COMMIT_A),
      ),
    );

    const sessions = join(env.guestAgentDir, "sessions");

    await mkdir(sessions, { recursive: true });

    const result = await env.sync(sources);

    expect(result.notices).toEqual([]);
    expect((await env.volumeSettings()).packages).toEqual(sources);
    expect(env.removals()).toHaveLength(0);
    expect(await exists(sessions)).toBe(true);
    expect(await env.stamp()).toEqual({});
  });
});
