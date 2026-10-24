import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushMicrotasks, hiddenMessageTexts } from "../../../../../test-framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { limitsPlugin } from "../../../api/plugins/limits.ts";
import { runAgentPlugin } from "../../../api/plugins/run-agent.ts";
import { snapshotLine, snapshotOf } from "../../../core/agent-status/snapshot.ts";
import type { AgentRecord } from "../../../core/model/agent-record.ts";
import { MANIFEST_FILE } from "../../../core/model/paths.ts";
import type { Settings } from "../../../core/model/settings.ts";
import type { Runner } from "../../../core/run-agent/runner.ts";
import type { RunAgentParams } from "../../../core/run-agent/tools.ts";
import { createWorktree } from "../../../core/run-agent/worktree.ts";
import { createHarness, tempDir } from "../../support/subagents-harness.ts";

const fixedBytes = vi.hoisted(() => ({ value: undefined as Buffer | undefined }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();

  return {
    ...actual,
    randomBytes: (size: number) => fixedBytes.value?.subarray(0, size) ?? actual.randomBytes(size),
  };
});

afterEach(() => {
  fixedBytes.value = undefined;
});

const BRANCH = /^pi-agents\/isolated-[0-9a-f]{12}-[0-9a-z]+$/;

const REPOSITORY_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !REPOSITORY_OVERRIDES.includes(key)),
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();

const createRepo = () => {
  const repo = realpathSync(tempDir("pi-subagents-repo-"));

  git(repo, "init", "-q");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");

  return repo;
};

const ISOLATED_AGENT = [
  "---",
  "name: isolated",
  "description: Edits code in its own worktree",
  "limit: 50000",
  "tools: all",
  "skills: all",
  "subagents: []",
  "worktree: true",
  "---",
  "Edit code.",
].join("\n");

const setup = (cwd: string, overrides: Partial<Settings> = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin, limitsPlugin], {
    overrides,
  });

  const agents = join(harness.host.info.agentDir, "agents");

  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "isolated.md"), ISOLATED_AGENT);
  harness.host.info.cwd = cwd;
  harness.host.start();

  const registry = harness.services.require("registry");
  const current = (id: string) => registry.get(id) as AgentRecord;

  const start = (agent = "isolated") =>
    harness.host
      .tool<RunAgentParams, unknown>("run_agent")
      .execute({ agents: [{ agent, task: "rename app" }] }, { update: () => {} });

  const run = async (agent = "isolated") => {
    await start(agent);
    await flushMicrotasks();

    return registry.list()[0];
  };

  return { ...harness, registry, current, start, run };
};

const commit = (cwd: string, ...args: string[]) =>
  git(cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", ...args);

const worktreeOf = (repo: string, record: AgentRecord) => {
  const branch = record.worktree?.branch ?? "";
  const path = join(repo, ".pi", "worktrees", branch.replace("pi-agents/", ""));

  return { path, branch };
};

describe("createWorktree", () => {
  it("adds a worktree under .pi/worktrees on a pi-agents branch and maps a subdirectory cwd into it", async () => {
    const repo = createRepo();
    const cwd = join(repo, "src");
    const result = await createWorktree(cwd, "scout-ab12");
    const branch = result.ok ? result.worktree.branch : "";
    const path = join(cwd, ".pi", "worktrees", branch.replace("pi-agents/", ""));

    expect(branch).toMatch(/^pi-agents\/scout-ab12-[0-9a-z]+$/);
    expect(result).toEqual({
      ok: true,
      worktree: { path, branch, base: git(repo, "rev-parse", "HEAD"), cwd: join(path, "src") },
    });
    expect(readFileSync(join(path, "src", "app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(git(repo, "worktree", "list")).toContain(path);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(cwd, ".pi", "worktrees", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("keeps an existing .pi/worktrees/.gitignore", async () => {
    const repo = createRepo();

    mkdirSync(join(repo, ".pi", "worktrees"), { recursive: true });
    writeFileSync(join(repo, ".pi", "worktrees", ".gitignore"), "custom\n");
    await createWorktree(repo, "scout-ab12");

    expect(readFileSync(join(repo, ".pi", "worktrees", ".gitignore"), "utf8")).toBe("custom\n");
  });

  it("returns the fs error when .pi/worktrees cannot be created", async () => {
    const repo = createRepo();

    writeFileSync(join(repo, ".pi"), "not a folder\n");

    const result = await createWorktree(repo, "scout-ab12");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("ENOTDIR");
  });
});

describe("worktree agents", () => {
  const finished = async (repo: string, prepare: (path: string) => void = () => {}) => {
    const harness = setup(repo);
    const record = await harness.run();

    await vi.waitFor(() => expect(harness.runtime.children).toHaveLength(1));

    const { path, branch } = worktreeOf(repo, harness.current(record.id));

    prepare(path);
    harness.host.settle();
    harness.runtime.child(record.id).finish("Renamed.");
    await vi.waitFor(() => expect(hiddenMessageTexts(harness.host)).toHaveLength(1));

    return { ...harness, record, path, branch };
  };

  it("spawns the child in its own worktree under .pi/worktrees and reports the path while it runs", async () => {
    const repo = createRepo();
    const { run, runtime, current } = setup(repo);
    const record = await run();

    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));

    const { path, branch } = worktreeOf(repo, current(record.id));

    expect(branch).toMatch(BRANCH);
    expect(branch.startsWith(`pi-agents/${record.id}-`)).toBe(true);
    expect(runtime.child(record.id).spec.cwd).toBe(path);
    expect(existsSync(join(path, "src", "app.ts"))).toBe(true);
    const base = git(repo, "rev-parse", "HEAD");

    expect(current(record.id).worktree).toEqual({ path, branch, base, cwd: path });
    expect(JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8")).worktree).toEqual({
      path,
      branch,
      base,
      cwd: path,
    });
    expect(snapshotLine(snapshotOf(current(record.id), Date.now()))).toContain(
      `  worktree: ${path} (branch ${branch})`,
    );
  });

  it("removes a clean worktree and its branch when the agent is done", async () => {
    const repo = createRepo();
    const { host, current, record, path, branch } = await finished(repo);

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    expect(current(record.id).worktree?.cleanup).toBe("removed");
    expect(JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8")).worktree.cleanup).toBe(
      "removed",
    );
    expect(hiddenMessageTexts(host)[0]).toContain("Worktree: removed");
    expect(snapshotLine(snapshotOf(current(record.id), Date.now()))).toContain("  worktree: removed");
  });

  it("removes the worktree but keeps the branch when the agent committed", async () => {
    const repo = createRepo();
    const { host, current, record, path, branch } = await finished(repo, (worktree) => {
      writeFileSync(join(worktree, "src", "app.ts"), "export const app = 2;\n");
      commit(worktree, "-a", "-m", "rename");
    });

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(current(record.id).worktree?.cleanup).toBe("branch kept");
    expect(hiddenMessageTexts(host)[0]).toContain(`Worktree: removed; branch ${branch} kept`);
  });

  it("keeps the worktree and its branch when the agent left uncommitted changes", async () => {
    const repo = createRepo();
    const { host, current, record, path, branch } = await finished(repo, (worktree) => {
      writeFileSync(join(worktree, "notes.txt"), "draft\n");
    });

    expect(existsSync(join(path, "notes.txt"))).toBe(true);
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(current(record.id).worktree?.cleanup).toBe("kept");
    expect(hiddenMessageTexts(host)[0]).toContain(`Worktree: kept: ${path} (branch ${branch})`);
  });

  it("removes an unchanged branch even when the main checkout moved to an unrelated branch", async () => {
    const repo = createRepo();
    const { current, record, path, branch } = await finished(repo, () => {
      git(repo, "checkout", "-q", "--orphan", "other");
      commit(repo, "--allow-empty", "-m", "other");
    });

    await vi.waitFor(() => expect(current(record.id).worktree?.cleanup).toBe("removed"));

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toBe("");
  });

  it("reports both worktrees as removed when two agents of one batch finish together", async () => {
    const repo = createRepo();
    const { host, runtime, registry } = setup(repo);

    await host.tool<RunAgentParams, unknown>("run_agent").execute(
      {
        agents: [
          { agent: "isolated", task: "a" },
          { agent: "isolated", task: "b" },
        ],
      },
      { update: () => {} },
    );
    await vi.waitFor(() => expect(runtime.children).toHaveLength(2));
    host.settle();

    const [first, second] = registry.list();

    runtime.child(first.id).finish("A.");
    runtime.child(second.id).finish("B.");
    await vi.waitFor(() => expect(hiddenMessageTexts(host)).toHaveLength(1));

    expect(hiddenMessageTexts(host)[0].match(/Worktree: removed/g)).toHaveLength(2);
    expect(hiddenMessageTexts(host)[0]).not.toContain(".pi/worktrees");
  });

  it("removes the worktree of a stopped agent only after its child is gone", async () => {
    const repo = createRepo();
    const { run, runtime, current, services } = setup(repo);
    const record = await run();

    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));

    const child = runtime.child(record.id);
    const { path } = worktreeOf(repo, current(record.id));

    child.abortDelayMs = 200;

    const stopping = (services.require("runner") as Runner).stop(record.id, { immediate: true });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(current(record.id).state).toBe("stopped");
    expect(existsSync(path)).toBe(true);

    await stopping;
    await vi.waitFor(() => expect(current(record.id).worktree?.cleanup).toBe("removed"));

    expect(child.disposed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("fails the agent and settles the batch when .pi/worktrees cannot be created", async () => {
    const repo = createRepo();

    writeFileSync(join(repo, ".pi"), "not a folder\n");

    const { run, runtime, current, host } = setup(repo);
    const record = await run();

    await vi.waitFor(() => expect(hiddenMessageTexts(host)).toHaveLength(1));

    expect(current(record.id).state).toBe("failed");
    expect(current(record.id).error).toContain("worktree failed: ENOTDIR");
    expect(runtime.children).toHaveLength(0);
  });

  it("removes the worktree of a stopped agent only after a slow dispose has finished", async () => {
    const repo = createRepo();
    const { run, runtime, current, services } = setup(repo);
    const record = await run();

    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));

    const child = runtime.child(record.id);
    const { path } = worktreeOf(repo, current(record.id));
    let presentAfterDispose = false;

    child.dispose = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      presentAfterDispose = existsSync(path);
    };

    await (services.require("runner") as Runner).stop(record.id, { immediate: true });
    await vi.waitFor(() => expect(current(record.id).worktree?.cleanup).toBe("removed"));

    expect(presentAfterDispose).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("records the cleanup of an agent that finished just before shutdown when shutdown returns", async () => {
    const repo = createRepo();
    const { run, runtime, current, services, host } = setup(repo);
    const record = await run();

    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));
    host.settle();
    runtime.child(record.id).finish("Renamed.");
    await (services.require("runner") as Runner).shutdown("quit");

    expect(current(record.id).worktree?.cleanup).toBe("removed");
  });

  it("settles a stopped agent that waits for a slot at once and frees the slot later", async () => {
    const repo = createRepo();
    const { start, runtime, registry, services, host } = setup(repo, { maxConcurrent: 1 });

    await start("scout");
    await start("scout");
    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));

    const [running, waiting] = registry.list();

    await (services.require("runner") as Runner).stop(waiting.id, { immediate: true });
    await vi.waitFor(() => expect(hiddenMessageTexts(host)).toHaveLength(1));

    expect(hiddenMessageTexts(host)[0]).toContain(`${waiting.id} (scout) - stopped`);

    host.settle();
    runtime.child(running.id).finish("Done.");
    await vi.waitFor(() => expect(hiddenMessageTexts(host)).toHaveLength(2));
    await start("scout");
    await vi.waitFor(() => expect(runtime.children).toHaveLength(2));
  });

  it("disposes a child whose spawn was still running at shutdown before removing its worktree", async () => {
    const repo = createRepo();
    const { start, runtime, registry, services } = setup(repo);
    const spawn = runtime.spawn;
    let presentAtDispose = false;

    runtime.spawn = async (spec) => {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const child = await spawn(spec);
      const dispose = child.dispose;

      child.dispose = () => {
        presentAtDispose = existsSync(spec.cwd);
        return dispose();
      };

      return child;
    };

    await start();
    await vi.waitFor(() => expect(registry.list()[0].worktree).toBeDefined());
    await (services.require("runner") as Runner).shutdown("quit");

    const [record] = registry.list();

    expect(runtime.child(record.id).disposed).toBe(true);
    expect(presentAtDispose).toBe(true);
    expect(record.worktree?.cleanup).toBe("removed");
  });

  it("closes the agent as failed with the git error before spawning outside a repository", async () => {
    const outside = tempDir("pi-subagents-plain-");
    const { run, runtime, current } = setup(outside);
    const record = await run();

    await vi.waitFor(() => expect(current(record.id).state).toBe("failed"));

    expect(current(record.id).error).toContain("worktree failed: fatal: not a git repository");
    expect(runtime.children).toHaveLength(0);
  });

  it("leaves agents without the field in the session cwd", async () => {
    const outside = tempDir("pi-subagents-plain-");
    const { run, runtime } = setup(outside);
    const record = await run("scout");

    expect(runtime.child(record.id).spec.cwd).toBe(outside);
  });

  it("lets a successor continue in the predecessor's worktree", async () => {
    const repo = createRepo();
    const { run, runtime, current, host } = setup(repo);
    const first = await run();

    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));
    host.settle();

    runtime.child(first.id).turn({ tokens: first.contextLimit + 500, window: 1_000_000, percent: 20 });
    await flushMicrotasks();

    mkdirSync(dirname(current(first.id).handoffPath), { recursive: true });
    writeFileSync(
      current(first.id).handoffPath,
      "## Status\npartial\n\n## Outcome\n- a\n\n## Evidence\n- b\n\n## Blocker\nnone\n\n## Next\n- c\n\n## Files touched\nnone",
    );
    runtime.child(first.id).finish(current(first.id).handoffPath);
    await flushMicrotasks();

    const second = current(first.id).successorId as string;

    await vi.waitFor(() => expect(runtime.children).toHaveLength(2));

    const { path, branch } = worktreeOf(repo, current(second));

    expect(current(second).worktree).toEqual(current(first.id).worktree);
    expect(runtime.child(second).spec.cwd).toBe(runtime.child(first.id).spec.cwd);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(2);

    runtime.child(second).finish("Renamed.");
    await vi.waitFor(() => expect(hiddenMessageTexts(host)).toHaveLength(1));

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    expect(current(first.id).worktree?.cleanup).toBe("removed");
    expect(current(second).worktree?.cleanup).toBe("removed");
  });

  it("removes the worktree and spawns nothing when the agent is stopped while git creates it", async () => {
    const repo = createRepo();
    const { start, runtime, registry, services } = setup(repo);

    await start();

    const [record] = registry.list();

    await services.require("runner").stop(record.id);
    await vi.waitFor(() => expect(registry.get(record.id)?.worktree?.cleanup).toBe("removed"));

    const { path, branch } = worktreeOf(repo, registry.get(record.id) as AgentRecord);
    const manifest = JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8"));

    expect(registry.get(record.id)?.state).toBe("stopped");
    expect(runtime.children).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    expect(manifest.worktree.cleanup).toBe("removed");
  });

  it("removes the worktree and its branch when the agent fails to spawn", async () => {
    const repo = createRepo();
    const { start, runtime, registry } = setup(repo);

    runtime.failNextSpawn = "no session";
    await start();

    const [record] = registry.list();

    await vi.waitFor(() => expect(registry.get(record.id)?.state).toBe("failed"));
    await vi.waitFor(() => expect(git(repo, "branch", "--list", "pi-agents/*")).toBe(""));

    await vi.waitFor(() => expect(registry.get(record.id)?.worktree?.cleanup).toBe("removed"));

    expect(registry.get(record.id)?.error).toBe("spawn failed: no session");
    expect(existsSync(worktreeOf(repo, registry.get(record.id) as AgentRecord).path)).toBe(false);
  });

  it("gives an agent whose id repeats one from an earlier session a branch of its own", async () => {
    const repo = createRepo();

    fixedBytes.value = Buffer.from("abcdef", "hex");

    const earlier = setup(repo);
    const first = await earlier.run();

    await vi.waitFor(() => expect(earlier.runtime.children).toHaveLength(1));

    const later = setup(repo);
    const second = await later.run();

    await vi.waitFor(() => expect(later.runtime.children).toHaveLength(1));

    expect(second.id).toBe(first.id);
    expect(later.current(second.id).state).toBe("running");
    expect(later.current(second.id).worktree?.branch).not.toBe(earlier.current(first.id).worktree?.branch);
  });
});
