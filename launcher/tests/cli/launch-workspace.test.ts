import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LABELS } from "../../container/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import type { FakeCall } from "../support/fake-runner.ts";
import { createHarness, type HarnessOptions } from "./harness.ts";

const WORKSPACE_NOTICE = "pi-sandbox: workspace with 2 repositories, git metadata protected";

const NESTED_FILES_NOTICE = "pi-sandbox: workspace: nested .git files are not read-only on this backend";

const overlayNotice = (places: string) =>
  `pi-sandbox: node_modules overlaid in ${places}; host node_modules is hidden; set mounts.autoNodeModules=false to keep it`;

const CAPPED_NOTICE =
  "pi-sandbox: more than 512 node_modules directories; overlay disabled, host node_modules is used";

const occurrences = (text: string, line: string) => text.split("\n").filter((entry) => entry === line).length;

const withoutOptions = (args: string[]): string[] =>
  args[0] === "-c" ? withoutOptions(args.slice(2)) : args;

const nestedGit = (call: FakeCall) => {
  const cwd = String(call.options.cwd ?? "");

  if (call.file !== "git" || !cwd.includes(`${sep}work`)) {
    return undefined;
  }

  const [command, flag] = withoutOptions(call.args);

  if (cwd.endsWith(`${sep}broken`)) {
    return { code: 128, stdout: "" };
  }

  if (command === "rev-parse" && flag === "--show-toplevel") {
    return { stdout: `${cwd}\n.git\n` };
  }

  return command === "config" ? { stdout: "" } : undefined;
};

interface Layout {
  repos: string[];
  lockfiles?: string[];
}

const workspaceHarness = async (layout: Layout, options: HarnessOptions = {}) => {
  const harness = await createHarness({ ...options, respond: nestedGit });
  const work = join(harness.root, "work");

  layout.repos.forEach((repo) => {
    mkdirSync(join(work, repo, ".git", "hooks"), { recursive: true });
  });

  (layout.lockfiles ?? []).forEach((file) => {
    mkdirSync(join(work, file, ".."), { recursive: true });

    writeFileSync(join(work, file), "{}");
  });

  return { ...harness, work, deps: { ...harness.deps, cwd: work } };
};

const pinned = async (gitDir: string) =>
  (await lstat(join(gitDir, "commondir")).catch(() => undefined)) !== undefined;

describe("pi in a folder of repositories", () => {
  it("says once that the workspace's repositories are protected", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "deep/b"] }, { adapters: () => [fake.backend] });

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), WORKSPACE_NOTICE)).toBe(1);
    expect(harness.stderr()).not.toContain(NESTED_FILES_NOTICE);
    expect(fake.containers.size).toBe(1);
  });

  it("warns that nested .git files stay writable on a backend without single-file mounts", async () => {
    const fake = createFakeBackend({ capabilities: { singleFileMount: false } });
    const harness = await workspaceHarness({ repos: ["a", "b"] }, { adapters: () => [fake.backend] });

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), NESTED_FILES_NOTICE)).toBe(1);
  });

  it("refuses a nested repository git does not confirm and starts nothing", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "broken"] }, { adapters: () => [fake.backend] });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pi-sandbox: workspace: ${join(harness.work, "broken")} cannot be protected`,
    );
    expect(harness.stderr()).toContain("hint: fix or move that repository, or start pi inside it");
    expect(fake.containers.size).toBe(0);
  });

  it("runs status, gc, reset and migrate in a workspace the launch refuses", async () => {
    const source = createFakeBackend();
    const target = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "broken"] },
      { adapters: () => [source.backend, { ...target.backend, name: "apple" }] },
    );

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(`repo: ${harness.work}\n`);
    expect(await run(["sandbox", "gc"], harness.deps)).toBe(0);
    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(`no container for ${harness.work}\n`);
    expect(await run(["sandbox", "migrate", "--to", "apple"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("set backend to apple in ");
    expect(harness.stderr()).not.toContain("cannot be protected");
  });

  it("runs host pi with --no-sandbox in a workspace the launch refuses", async () => {
    const harness = await workspaceHarness({ repos: ["a", "broken"] });
    const hostDir = join(harness.root, "host-bin");
    const hostPi = join(hostDir, "pi");

    await mkdir(hostDir, { recursive: true });

    await writeFile(hostPi, "#!/bin/sh\necho host pi\n");

    await chmod(hostPi, 0o755);

    harness.deps.env.PATH = hostDir;

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("cannot be protected");
    expect(harness.calls.find((call) => call.interactive)?.file).toBe(hostPi);
  });

  it("releases the pin of each nested repository unless another running sandbox mounts its git dir", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "b"] }, { adapters: () => [fake.backend] });
    const shared = join(harness.work, "a", ".git");
    const own = join(harness.work, "b", ".git");

    fake.addContainer({
      name: "pi-sandbox-a",
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: "other", [LABELS.gitCommonDir]: shared },
      state: "running",
      image: "x",
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(await pinned(shared)).toBe(true);
    expect(await pinned(own)).toBe(false);
  });
});

describe("the node_modules overlay notice", () => {
  it("names one directory in the singular", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json"] },
      { adapters: () => [fake.backend] },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), overlayNotice("1 directory"))).toBe(1);
  });

  it("counts several directories in the plural", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json", "b/pnpm-lock.yaml", "tools/yarn.lock"] },
      { adapters: () => [fake.backend] },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), overlayNotice("3 directories"))).toBe(1);
  });

  it("says the overlay is off when there are more than 512 node projects", async () => {
    const fake = createFakeBackend();
    const lockfiles = Array.from({ length: 513 }, (_, index) => `a/p${index}/package-lock.json`);
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles },
      { adapters: () => [fake.backend] },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), CAPPED_NOTICE)).toBe(1);
    expect(harness.stderr()).not.toContain("node_modules overlaid");
  });

  it("stays silent when mounts.autoNodeModules is off", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json"] },
      { adapters: () => [fake.backend] },
    );

    await harness.writeJson(harness.userConfigFile, { mounts: { autoNodeModules: false } });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("node_modules overlaid");
  });

  it("stays silent without node projects", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "b"] }, { adapters: () => [fake.backend] });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("node_modules overlaid");
  });
});
