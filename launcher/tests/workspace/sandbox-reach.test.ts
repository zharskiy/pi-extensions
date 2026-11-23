import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoHash, writeRepoRecord } from "../../shared/index.ts";
import { isSandboxWritable, sandboxWriteRoots } from "../../workspace/index.ts";
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
});
