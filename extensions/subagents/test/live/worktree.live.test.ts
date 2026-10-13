import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeLive } from "../../../../core/test/adapter/live.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=live", "-c", "user.email=live@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

describeLive("live worktree agent", () => {
  let live: LiveHarness;

  beforeAll(() => {
    live = createLiveHarness("worktree", {
      agents: {
        "implementer-worktree": { from: "implementer", fields: { tools: "[write]", worktree: "true" } },
      },
    });

    writeFileSync(join(live.project, "README.md"), "live test repository\n");
    git(live.project, ["init", "-q", "-b", "main"]);
    git(live.project, ["add", "README.md"]);
    git(live.project, ["commit", "-q", "-m", "initial"]);
  });

  afterAll(async () => {
    await live?.close();
  });

  it("writes the file in its own worktree under .pi/worktrees and keeps the uncommitted worktree when done", async () => {
    const id = await live.run(
      "implementer-worktree",
      "Use the write tool once to create the file hello.txt in your current working directory with the word hi as its content, then reply with the single word DONE.",
    );

    await live.waitForWakes(1);

    const record = live.registry.get(id);
    const worktree = record?.worktree;

    expect(record?.state).toBe("done");
    expect(worktree?.branch).toMatch(/^pi-agents\//);
    expect(worktree?.path.startsWith(join(live.project, ".pi", "worktrees"))).toBe(true);
    expect(worktree?.cleanup).toBe("kept");
    expect(existsSync(join(worktree?.cwd ?? "", "hello.txt"))).toBe(true);
    expect(git(worktree?.path ?? "", ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(worktree?.branch);
    expect(git(live.project, ["branch", "--list", worktree?.branch ?? ""])).toContain(worktree?.branch);
    expect(git(live.project, ["status", "--porcelain"])).toBe("");
  });
});
