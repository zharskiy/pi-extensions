import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { MANIFEST_FILE } from "../../../src/model/paths.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { snapshotLine, snapshotOf } from "../../../src/plugins/agent-status/snapshot.ts";
import { handoffPlugin } from "../../../src/plugins/handoff/index.ts";
import { limitsPlugin } from "../../../src/plugins/limits/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createWorktree, WORKTREE_DIR, worktreeBranch } from "../../../src/plugins/run-agent/worktree.ts";
import { createHarness, tempDir } from "../../helpers/harness.ts";

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

const BRANCH = /^pi-agents\/isolated-[0-9a-f]{4}-[0-9a-z]+$/;

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

const setup = (cwd: string) => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    handoffPlugin,
    runAgentPlugin,
    limitsPlugin,
  ]);

  const agents = join(harness.host.info.agentDir, "agents");

  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "isolated.md"), ISOLATED_AGENT);
  harness.host.info.cwd = cwd;
  harness.services.require("definitions").reload();

  const registry = harness.services.require("registry");
  const current = (id: string) => registry.get(id) as AgentRecord;

  const start = (agent = "isolated") =>
    harness.host
      .tool<RunAgentParams, unknown>("run_agent")
      .execute({ agents: [{ agent, task: "rename app" }] }, { update: () => {} });

  const run = async (agent = "isolated") => {
    await start(agent);
    await flush();

    return registry.list()[0];
  };

  return { ...harness, registry, current, start, run };
};

describe("createWorktree", () => {
  it("adds a worktree on a pi-agents branch and maps a subdirectory cwd into it", async () => {
    const repo = createRepo();
    const agentDir = join(tempDir(), "explorer-ab12");
    const branch = worktreeBranch("explorer-ab12", "mg5x1k2a");
    const result = await createWorktree(join(repo, "src"), agentDir, branch);
    const path = join(agentDir, WORKTREE_DIR);

    expect(branch).toBe("pi-agents/explorer-ab12-mg5x1k2a");
    expect(result).toEqual({ ok: true, worktree: { path, branch, cwd: join(path, "src") } });
    expect(readFileSync(join(path, "src", "app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(git(repo, "worktree", "list")).toContain(path);
  });

  it("reports a directory outside any git repository", async () => {
    const outside = tempDir("pi-subagents-plain-");
    const result = await createWorktree(outside, join(outside, "agent"), "pi-agents/a-1-x");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(`${outside} is not inside a git repository`);
  });
});

describe("worktree agents", () => {
  it("spawns the child in its own worktree and reports the path everywhere", async () => {
    const repo = createRepo();
    const { run, runtime, current, host } = setup(repo);
    const record = await run();

    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));

    const path = join(record.dir, WORKTREE_DIR);
    const child = runtime.child(record.id);

    expect(child.spec.cwd).toBe(path);
    expect(existsSync(join(path, "src", "app.ts"))).toBe(true);
    const branch = current(record.id).worktree?.branch ?? "";

    expect(branch).toMatch(BRANCH);
    expect(branch.startsWith(`pi-agents/${record.id}-`)).toBe(true);
    expect(current(record.id).worktree).toEqual({ path, branch, cwd: path });
    expect(JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8")).worktree).toMatchObject({
      path,
      branch,
    });

    host.settle();
    child.finish("Renamed.");
    await flush();

    const manifest = JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8"));

    expect(manifest.worktree).toMatchObject({ path, branch });
    expect(host.sent[0]).toContain(`Worktree: ${path} (branch ${branch})`);
    expect(snapshotLine(snapshotOf(current(record.id), Date.now()))).toContain(
      `  worktree: ${path} (branch ${branch})`,
    );
  });

  it("closes the agent as failed with the git error before spawning outside a repository", async () => {
    const outside = tempDir("pi-subagents-plain-");
    const { run, runtime, current } = setup(outside);
    const record = await run();

    await vi.waitFor(() => expect(current(record.id).state).toBe("failed"));

    expect(current(record.id).error).toContain(`worktree failed: ${outside} is not inside a git repository`);
    expect(runtime.children).toHaveLength(0);
  });

  it("leaves agents without the field in the session cwd", async () => {
    const outside = tempDir("pi-subagents-plain-");
    const { run, runtime } = setup(outside);
    const record = await run("explorer");

    expect(runtime.child(record.id).spec.cwd).toBe(outside);
  });

  it("lets a successor continue in the predecessor's worktree", async () => {
    const repo = createRepo();
    const { run, runtime, current, host } = setup(repo);
    const first = await run();

    await vi.waitFor(() => expect(runtime.children).toHaveLength(1));
    host.settle();

    runtime.child(first.id).turn({ tokens: first.contextLimit + 500, window: 1_000_000, percent: 20 });
    await flush();

    mkdirSync(dirname(current(first.id).handoffPath), { recursive: true });
    writeFileSync(
      current(first.id).handoffPath,
      "## Status\npartial\n\n## Outcome\n- a\n\n## Evidence\n- b\n\n## Blocker\nnone\n\n## Next\n- c\n\n## Files touched\nnone",
    );
    runtime.child(first.id).finish(current(first.id).handoffPath);
    await flush();

    const second = current(first.id).successorId as string;

    await vi.waitFor(() => expect(runtime.children).toHaveLength(2));

    expect(current(second).worktree).toEqual(current(first.id).worktree);
    expect(runtime.child(second).spec.cwd).toBe(runtime.child(first.id).spec.cwd);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(2);
  });

  it("removes the worktree and spawns nothing when the agent is stopped while git creates it", async () => {
    const repo = createRepo();
    const { start, runtime, registry, services, bus } = setup(repo);
    const seen: (string | undefined)[] = [];

    bus.on("agent:changed", (record) => {
      seen.push(record.worktree?.branch);
    });

    await start();

    const [record] = registry.list();

    await services.require("runner").stop(record.id);
    await vi.waitFor(() => expect(seen.filter(Boolean).length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(seen.at(-1)).toBeUndefined());

    const branch = seen.find(Boolean) as string;
    const manifest = JSON.parse(readFileSync(join(record.dir, MANIFEST_FILE), "utf8"));

    expect(registry.get(record.id)?.state).toBe("stopped");
    expect(runtime.children).toHaveLength(0);
    expect(existsSync(join(record.dir, WORKTREE_DIR))).toBe(false);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    expect(manifest.worktree).toBeUndefined();
  });

  it("removes the worktree and its branch when the agent fails to spawn", async () => {
    const repo = createRepo();
    const { start, runtime, registry } = setup(repo);

    runtime.failNextSpawn = "no session";
    await start();

    const [record] = registry.list();

    await vi.waitFor(() => expect(registry.get(record.id)?.state).toBe("failed"));
    await vi.waitFor(() => expect(git(repo, "branch", "--list", "pi-agents/*")).toBe(""));

    expect(registry.get(record.id)).toMatchObject({ error: "spawn failed: no session", worktree: undefined });
    expect(existsSync(join(record.dir, WORKTREE_DIR))).toBe(false);
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
