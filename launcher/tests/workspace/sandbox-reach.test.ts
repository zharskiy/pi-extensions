import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoHash, writeRepoRecord } from "../../shared/index.ts";
import { hostLinkGuard, isSandboxWritable, sandboxWriteRoots } from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const setup = async () => {
  const base = await realpath(await tempDir("reach"));
  const work = join(base, "work");
  const elsewhere = join(base, "elsewhere", "old");
  const stateDir = join(base, "state");

  await mkdir(join(work, "a"), { recursive: true });
  await mkdir(elsewhere, { recursive: true });

  await writeRepoRecord(stateDir, repoHash(elsewhere), elsewhere);

  return { home: join(base, "home"), env: {}, stateDir, work, elsewhere, base };
};

describe("sandbox reach", () => {
  it("answers by the workspace root and the folders a sandbox has run in", async () => {
    const { work, elsewhere, base, ...rest } = await setup();
    const context = { ...rest, workspaceRoot: work };

    expect(await sandboxWriteRoots(context)).toEqual([work, elsewhere]);
    expect(await isSandboxWritable([join(work, "b", "ext.ts")], context)).toBe(true);
    expect(await isSandboxWritable([join(elsewhere, "x")], context)).toBe(true);
    expect(await isSandboxWritable([join(base, "other", "x")], context)).toBe(false);
  });

  it("keeps the root a sandbox mounted writable after the root changes or the config cannot be read", async () => {
    const { work, elsewhere, base, stateDir, ...rest } = await setup();
    const project = join(work, "a");
    const moved = join(base, "moved");

    await writeRepoRecord(stateDir, repoHash(project), project, work);

    const changed = await sandboxWriteRoots({ ...rest, stateDir, workspaceRoot: moved });
    const unreadable = await sandboxWriteRoots({ ...rest, stateDir });

    expect(new Set(changed)).toEqual(new Set([moved, elsewhere, project, work]));
    expect(new Set(unreadable)).toEqual(new Set([elsewhere, project, work]));
    expect(await isSandboxWritable([join(work, "b", "ext.ts")], { ...rest, stateDir })).toBe(true);
  });

  it("falls back to the recorded folders without a usable workspace root", async () => {
    const { work, elsewhere, ...context } = await setup();

    expect(await sandboxWriteRoots(context)).toEqual([elsewhere]);
    expect(await sandboxWriteRoots({ ...context, workspaceRoot: context.home })).toEqual([elsewhere]);
    expect(await isSandboxWritable([join(work, "a")], context)).toBe(false);
  });

  it("refuses host links into or above a folder a sandbox can write, and link targets in protected paths", async () => {
    const { work, elsewhere, base, ...context } = await setup();
    const mounted = join(base, "mounted");
    const guard = await hostLinkGuard({ ...context, workspaceRoot: work }, mounted);

    expect(guard.writable(join(mounted, "x"))).toBe(`it lies in ${mounted}, which a sandbox can write`);
    expect(guard.writable(join(elsewhere, "x"))).toBe(`it lies in ${elsewhere}, which a sandbox can write`);
    expect(guard.writable(join(base, "elsewhere"))).toBe(`it holds ${elsewhere}, which a sandbox can write`);
    expect(guard.writable(join(base, "other"))).toBeUndefined();
    expect(guard.link(join(base, "other"))).toBeUndefined();
    expect(guard.link(join(context.home, ".ssh", "id_ed25519"))).toBe("it is inside ~/.ssh");
    expect(guard.writable(join(context.home, ".ssh", "id_ed25519"))).toBeUndefined();
  });

  it("refuses host links into or above a linked host sessions dir", async () => {
    const { work, elsewhere, base, ...context } = await setup();
    const data = join(base, "data", "pi-sessions");

    await mkdir(data, { recursive: true });

    await mkdir(join(context.home, ".pi", "agent"), { recursive: true });

    await symlink(data, join(context.home, ".pi", "agent", "sessions"));

    const guard = await hostLinkGuard(context, work);

    expect(guard.link(join(data, "x.jsonl"))).toBe(`it lies in ${data}, which a sandbox can write`);
    expect(guard.link(join(base, "data"))).toBe(`it holds ${data}, which a sandbox can write`);
  });
});
