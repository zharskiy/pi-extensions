import { access, chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Backend, ExecIo, ExecSpec } from "../../backend/index.ts";
import { syncVolumeFiles } from "../../provision/index.ts";
import { readJsonObject, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir, writeText } from "./fixtures.ts";

const COMMIT_A = "a".repeat(40);

const COMMIT_B = "b".repeat(40);

const TAG_OBJECT = "c".repeat(40);

const isRemoval = (spec: ExecSpec) => spec.command[2]?.includes("rm -rf --") === true;

const DEFERRED_NOTICE =
  "sandbox packages follow the host: git packages refresh at the next launch (another session is running)";

interface SetupOptions {
  hangRemoval?: boolean;
  removeTimeoutMs?: number;
}

const hangUntilAborted = (io: ExecIo) =>
  new Promise<number>((resolve) => io.signal?.addEventListener("abort", () => resolve(137)));

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const setup = async (options: SetupOptions = {}) => {
  const stateDir = await tempDir("packages-state");
  const repoRoot = await tempDir("packages-repo");
  const hostAgentDir = await tempDir("packages-host");
  const guestAgentDir = await tempDir("packages-volume");
  const fake = createFakeBackend({ guestAgentDir });
  const containerId = await runningContainer(fake.backend);
  const live = { others: false };
  const backend: Backend = {
    ...fake.backend,
    exec: (spec, io) =>
      options.hangRemoval === true && isRemoval(spec) ? hangUntilAborted(io) : fake.backend.exec(spec, io),
  };
  const sync = async (packages: unknown[], refreshPackages = true) => {
    await writeText(join(hostAgentDir, "settings.json"), JSON.stringify({ packages }));

    return syncVolumeFiles({
      backend,
      containerId,
      stateDir,
      repoHash: "repo1",
      hostAgentDir,
      repoRoot,
      refreshPackages,
      othersLive: () => Promise.resolve(live.others),
      removeTimeoutMs: options.removeTimeoutMs,
    });
  };
  const hostNpm = (name: string, version: string, manifestName = name) =>
    writeText(
      join(hostAgentDir, "npm", "node_modules", name, "package.json"),
      JSON.stringify({ name: manifestName, version }),
    );
  const hostGit = async (path: string, commit: string, onRemote = true) => {
    const gitDir = join(hostAgentDir, "git", path, ".git");

    await writeText(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

    await writeText(join(gitDir, "refs", "heads", "main"), `${commit}\n`);

    await writeText(join(gitDir, "refs", "remotes", "origin", "main"), `${onRemote ? commit : COMMIT_A}\n`);
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
  const removals = () => fake.execs.filter((exec) => isRemoval(exec.spec));

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

    await writeText(
      join(gitDir, "packed-refs"),
      `# pack-refs with: peeled\n${COMMIT_B} refs/heads/main\n${COMMIT_B} refs/remotes/origin/main\n`,
    );

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

    expect(deferred.notices).toEqual([DEFERRED_NOTICE]);
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
  it("leaves npm alias, hosted, URL and renamed specs as written", async () => {
    const env = await setup();
    const sources = [
      "npm:x@npm:other@2.0.0",
      "npm:x@github:user/repo",
      "npm:x@https://example.com/x.tgz",
      "npm:renamed",
    ];

    await env.hostNpm("x", "1.4.2");

    await env.hostNpm("renamed", "1.0.0", "other");

    const result = await env.sync(sources);

    expect(result.notices).toEqual([]);
    expect((await env.volumeSettings()).packages).toEqual(sources);
    expect(await env.stamp()).toEqual({});
  });

  it("keeps an exact npm pin as written", async () => {
    const env = await setup();

    await env.hostNpm("x", "1.4.2");

    await env.sync(["npm:x@1.0.0", "npm:x@v1.0.0"]);

    expect((await env.volumeSettings()).packages).toEqual(["npm:x@1.0.0", "npm:x@v1.0.0"]);
    expect(await env.stamp()).toEqual({});
  });

  it("pins range and tag npm sources, scoped names included", async () => {
    const env = await setup();

    await env.hostNpm("x", "1.4.2");

    await env.hostNpm("y", "3.0.0");

    await env.hostNpm("@scope/tool", "2.1.5");

    await env.sync(["npm:x@^1.2", "npm:y@latest", "npm:@scope/tool@>=2 <3"]);

    expect((await env.volumeSettings()).packages).toEqual([
      "npm:x@1.4.2",
      "npm:y@3.0.0",
      "npm:@scope/tool@2.1.5",
    ]);
    expect(await env.stamp()).toEqual({ "npm:x": "1.4.2", "npm:y": "3.0.0", "npm:@scope/tool": "2.1.5" });
  });

  it("leaves a git source unpinned when the host commit is not on the remote and still clears it on a change", async () => {
    const env = await setup();

    await env.hostGit("github.com/owner/repo", COMMIT_B, false);

    const first = await env.volumeCheckout("github.com/owner/repo");

    await env.sync(["git:github.com/owner/repo@main"]);

    expect((await env.volumeSettings()).packages).toEqual(["git:github.com/owner/repo@main"]);
    expect(await exists(first)).toBe(false);
    expect(await env.stamp()).toEqual({ "git:github.com/owner/repo": `unpinned:${COMMIT_B}` });

    const second = await env.volumeCheckout("github.com/owner/repo");

    await env.hostGit("github.com/owner/repo", TAG_OBJECT, false);

    const result = await env.sync(["git:github.com/owner/repo@main"]);

    expect(result.notices).toEqual(["sandbox packages follow the host: reinstalling 1 package"]);
    expect(await exists(second)).toBe(false);
  });

  it("pins a git source whose host commit is a peeled annotated tag", async () => {
    const env = await setup();
    const gitDir = join(env.hostAgentDir, "git", "github.com", "owner", "repo", ".git");

    await writeText(join(gitDir, "HEAD"), `${COMMIT_B}\n`);

    await writeText(
      join(gitDir, "packed-refs"),
      `${COMMIT_A} refs/remotes/origin/main\n${TAG_OBJECT} refs/tags/v1\n^${COMMIT_B}\n`,
    );

    await env.sync(["git:github.com/owner/repo@v1"]);

    expect((await env.volumeSettings()).packages).toEqual([`git:github.com/owner/repo@${COMMIT_B}`]);
  });

  it("names the volume checkout of a mixed-case hosted host the way pi does", async () => {
    const env = await setup();

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    const checkout = await env.volumeCheckout("github.com/owner/repo");

    await env.sync(["git:GitHub.com/owner/repo"]);

    expect((await env.volumeSettings()).packages).toEqual([`git:GitHub.com/owner/repo@${COMMIT_A}`]);
    expect(env.removals().map((exec) => exec.spec.command.at(-1))).toEqual(["git/github.com/owner/repo"]);
    expect(await exists(checkout)).toBe(false);
    expect(await env.stamp()).toEqual({ "git:github.com/owner/repo": COMMIT_A });
  });

  it("reads a git:// source as a protocol URL", async () => {
    const env = await setup();

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["git://github.com/owner/repo"]);

    expect((await env.volumeSettings()).packages).toEqual([`git://github.com/owner/repo@${COMMIT_A}`]);
    expect(await env.stamp()).toEqual({ "git:github.com/owner/repo": COMMIT_A });
  });

  it("refuses to remove a checkout under a symlinked parent", async () => {
    const env = await setup();
    const mounted = await tempDir("packages-mount");
    const planted = join(mounted, "owner", "repo", "index.ts");

    await writeText(planted, "keep");

    await mkdir(join(env.guestAgentDir, "git"), { recursive: true });

    await symlink(mounted, join(env.guestAgentDir, "git", "github.com"));

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    const result = await env.sync(["git:github.com/owner/repo"]);

    expect(result.notices).toEqual([
      "warning: the sandbox packages were not refreshed to follow the host: refused to remove git/github.com/owner/repo from the sandbox volume: a parent folder is a symbolic link",
    ]);
    expect(await exists(planted)).toBe(true);
    expect(await env.stamp()).toBeUndefined();
  });

  it("warns and keeps the record when the removal times out", async () => {
    const env = await setup({ hangRemoval: true, removeTimeoutMs: 50 });

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    const result = await env.sync(["git:github.com/owner/repo"]);

    expect(result.notices).toEqual([
      "warning: the sandbox packages were not refreshed to follow the host: could not remove the outdated packages from the sandbox volume: the command in the sandbox did not finish within 50 ms",
    ]);
    expect(await env.stamp()).toBeUndefined();
  });

  it("records and counts npm packages when the git refresh is deferred", async () => {
    const env = await setup();

    await env.hostNpm("tool", "1.0.0");

    await env.hostGit("github.com/owner/repo", COMMIT_A);

    await env.sync(["npm:tool", "git:github.com/owner/repo"]);

    await env.hostNpm("tool", "1.1.0");

    await env.hostGit("github.com/owner/repo", COMMIT_B);

    env.live.others = true;

    const deferred = await env.sync(["npm:tool", "git:github.com/owner/repo"]);

    expect(deferred.notices).toEqual([
      "sandbox packages follow the host: reinstalling 1 package",
      DEFERRED_NOTICE,
    ]);
    expect(await env.stamp()).toEqual({ "npm:tool": "1.1.0", "git:github.com/owner/repo": COMMIT_A });

    env.live.others = false;

    const retried = await env.sync(["npm:tool", "git:github.com/owner/repo"]);

    expect(retried.notices).toEqual(["sandbox packages follow the host: reinstalling 1 package"]);
    expect(await env.stamp()).toEqual({ "npm:tool": "1.1.0", "git:github.com/owner/repo": COMMIT_B });
  });
});
