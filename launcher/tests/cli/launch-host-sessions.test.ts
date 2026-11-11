import { chmod, lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { hostSessionsDir } from "../../workspace/index.ts";
import { createFakeBackend, createHarness, isPiSession } from "./harness.ts";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const header = (cwd: string) => `${JSON.stringify({ type: "session", id: "abc", cwd })}\n`;

describe("pi launch with host sessions", () => {
  it("binds the session dir at its own path and sweeps it before, during and after the run", async () => {
    const box = { dir: "", repoRoot: "" };
    const fake = createFakeBackend({
      exec: async (spec) => {
        if (!isPiSession(spec)) {
          return undefined;
        }

        await writeFile(join(box.dir, "run.jsonl"), header(box.repoRoot));

        await mkdir(join(box.dir, "run", "agents", "one"), { recursive: true });

        await symlink("/etc/passwd", join(box.dir, "run", "agents", "one", "leak.jsonl"));

        await symlink("/etc/passwd", join(box.dir, "late.jsonl"));

        await writeFile(join(box.dir, "foreign.jsonl"), header("/etc"));

        return 0;
      },
    });
    const harness = await createHarness({ backend: () => fake.backend });
    const dir = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);

    box.dir = dir;

    box.repoRoot = harness.repoRoot;

    await mkdir(dir, { recursive: true });

    await symlink("/etc/hosts", join(dir, "early.jsonl"));

    expect(await run([], harness.deps)).toBe(0);

    const spec = fake.created[0]?.spec;
    const names = (await readdir(dir)).sort();

    expect(spec?.mounts).toContainEqual({ source: dir, target: dir, readOnly: false, kind: "bind" });
    expect(spec?.env.PI_CODING_AGENT_SESSION_DIR).toBe(dir);
    expect(names.filter((name) => !name.startsWith("foreign.jsonl.rejected-"))).toEqual(["run", "run.jsonl"]);
    expect(names.some((name) => name.startsWith("foreign.jsonl.rejected-"))).toBe(true);
    expect(await readdir(join(dir, "run", "agents", "one"))).toEqual([]);
    expect(harness.stderr()).toContain(
      `pi-sandbox: sessions: ${join(dir, "foreign.jsonl")} names a cwd outside the repository; renamed to foreign.jsonl.rejected-`,
    );
  });
});

describe("pi --no-sandbox with host sessions", () => {
  it("sweeps the repository's session dir before host pi reads it, without a backend", async () => {
    const harness = await createHarness();
    const dir = hostSessionsDir(harness.hostAgentDir, harness.repoRoot);
    const bin = join(harness.root, "host-bin");

    await mkdir(bin, { recursive: true });

    await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n");

    await chmod(join(bin, "pi"), 0o755);

    harness.deps.env.PATH = bin;

    await mkdir(join(dir, "run", "agents"), { recursive: true });

    await symlink("/etc/passwd", join(dir, "late.jsonl"));

    await symlink("/etc/passwd", join(dir, "run", "agents", "leak.jsonl"));

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(await exists(join(dir, "late.jsonl"))).toBe(false);
    expect(await exists(join(dir, "run", "agents", "leak.jsonl"))).toBe(true);
  });
});
