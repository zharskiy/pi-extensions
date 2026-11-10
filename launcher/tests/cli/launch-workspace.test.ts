import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import type { FakeCall } from "../support/fake-runner.ts";
import { createFakeBackend, createHarness, type HarnessOptions } from "./harness.ts";

const WORKSPACE_NOTICE = "pi-sandbox: workspace with 2 repositories";

const overlayNotice = (places: string) =>
  `pi-sandbox: node_modules overlaid in ${places}; the host copies are hidden; set mounts.autoOverlays=false to keep them`;

const CAPPED_NOTICE =
  "pi-sandbox: more than 512 build output directories; overlays disabled, the host copies are used";

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

const _pinned = async (gitDir: string) =>
  (await lstat(join(gitDir, "commondir")).catch(() => undefined)) !== undefined;

describe("pi in a folder of repositories", () => {
  it("says once how many repositories the workspace holds", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "deep/b"] }, { backend: () => fake.backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), WORKSPACE_NOTICE)).toBe(1);
    expect(fake.created).toHaveLength(1);
  });

  it("refuses a nested repository git does not confirm and starts nothing", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "broken"] }, { backend: () => fake.backend });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pi-sandbox: workspace: ${join(harness.work, "broken")} cannot be protected`,
    );
    expect(harness.stderr()).toContain("hint: fix or move that repository, or start pi inside it");
    expect(fake.containers.size).toBe(0);
  });

  it("runs status and reset in a workspace the launch refuses", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "broken"] }, { backend: () => fake.backend });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(`workspace: ${harness.work}\n`);
    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(`no sandbox for ${harness.work}\n`);
    expect(harness.stderr()).not.toContain("cannot be protected");
  });

  it("runs host pi with --no-sandbox in a workspace the launch refuses", async () => {
    const harness = await workspaceHarness({ repos: ["a", "broken"] });

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("cannot be protected");
    expect(harness.calls.find((call) => call.interactive)?.file).toBe(process.execPath);
  });

  it("refuses the home and a folder under a dotfiles home before searching them, and still runs status there", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: [] }, { backend: () => fake.backend });
    const home = harness.deps.home;
    const project = join(home, "code", "project");
    const gitCalls = () => harness.calls.filter((call) => call.file === "git").length;

    await mkdir(join(home, "remote.git", "objects"), { recursive: true });
    await mkdir(join(home, "remote.git", "refs"), { recursive: true });
    await writeFile(join(home, "remote.git", "HEAD"), "ref: refs/heads/main\n");

    harness.deps.cwd = home;

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pi-sandbox: ${home} would mount ${home} into the sandbox, refusing`);
    expect(gitCalls()).toBe(0);

    await mkdir(join(home, ".git"));
    await mkdir(project, { recursive: true });

    harness.deps.cwd = project;

    expect(await run([], harness.deps)).toBe(1);
    expect(
      occurrences(harness.stderr(), `pi-sandbox: ${home} would mount ${home} into the sandbox, refusing`),
    ).toBe(2);
    expect(gitCalls()).toBe(0);
    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
  });

  it("hides build output behind an overlay volume and does not search for repositories inside it", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/uv.lock"] },
      { backend: () => fake.backend },
    );
    const venv = join(harness.work, "a", ".venv");

    await mkdir(join(venv, "lib", "dep", ".git"), { recursive: true });

    expect(await run([], harness.deps)).toBe(0);

    const mounts = fake.created[0]?.spec?.mounts ?? [];

    expect(mounts.find((mount) => mount.target === venv)).toMatchObject({ kind: "volume" });
    expect(mounts.some((mount) => mount.target.startsWith(join(venv, "lib")))).toBe(false);
  });

  it("searches build output for repositories when mounts.autoOverlays is off", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b", "a/.venv/lib/dep"], lockfiles: ["a/uv.lock"] },
      { backend: () => fake.backend },
    );
    const dep = join(harness.work, "a", ".venv", "lib", "dep");

    await harness.writeJson(harness.userConfigFile, { mounts: { autoOverlays: false } });

    expect(await run([], harness.deps)).toBe(0);

    const mounts = fake.created[0]?.spec?.mounts ?? [];

    expect(mounts.find((mount) => mount.target === join(dep, ".git", "hooks"))).toMatchObject({
      readOnly: true,
    });
    expect(mounts.some((mount) => mount.kind === "volume" && mount.target.startsWith(harness.work))).toBe(
      false,
    );
    expect(harness.stderr()).toContain("workspace with 3 repositories");
  });
});

describe("the overlay notice", () => {
  it("names one directory in the singular", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json"] },
      { backend: () => fake.backend },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), overlayNotice("1 directory"))).toBe(1);
  });

  it("prints the notice once per value, again only when the overlays change", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json"] },
      { backend: () => fake.backend },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), overlayNotice("1 directory"))).toBe(1);
    expect(occurrences(harness.stderr(), WORKSPACE_NOTICE)).toBe(1);

    await writeFile(join(harness.work, "b", "Cargo.lock"), "");

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      "pi-sandbox: node_modules, target overlaid in 2 directories; the host copies are hidden",
    );
  });

  it("counts several directories in the plural", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json", "b/pnpm-lock.yaml", "tools/yarn.lock"] },
      { backend: () => fake.backend },
    );

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), overlayNotice("3 directories"))).toBe(1);
  });

  it("says overlays are off when there are more than 512", async () => {
    const fake = createFakeBackend();
    const lockfiles = Array.from({ length: 513 }, (_, index) => `a/p${index}/package-lock.json`);
    const harness = await workspaceHarness({ repos: ["a", "b"], lockfiles }, { backend: () => fake.backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(occurrences(harness.stderr(), CAPPED_NOTICE)).toBe(1);
    expect(harness.stderr()).not.toContain("overlaid in");
  });

  it("stays silent when mounts.autoOverlays is off", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness(
      { repos: ["a", "b"], lockfiles: ["a/package-lock.json"] },
      { backend: () => fake.backend },
    );

    await harness.writeJson(harness.userConfigFile, { mounts: { autoOverlays: false } });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("overlaid in");
  });

  it("stays silent without overlay markers", async () => {
    const fake = createFakeBackend();
    const harness = await workspaceHarness({ repos: ["a", "b"] }, { backend: () => fake.backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).not.toContain("overlaid in");
  });
});
