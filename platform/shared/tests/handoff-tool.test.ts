import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import type { HandoffValidation } from "../handoff-document.ts";
import { type HandoffToolDeps, handoffTool } from "../handoff-tool.ts";

const temp = useTempDirs();

const ok = { ok: true, status: "partial" } as const;

const setup = (patch: Partial<HandoffToolDeps> = {}) => {
  const path = join(temp.make("pi-handoff-tool-"), "nested", "main-handoff.md");
  const onSaved = vi.fn();

  const tool = handoffTool({
    target: () => ({ path, requested: true }),
    validate: () => ok,
    rows: {},
    onSaved,
    ...patch,
  });

  const save = (content: string) => tool.execute({ content }, { update: () => {} });

  return { path, onSaved, save, tool };
};

describe("handoff tool", () => {
  it("refuses without a target or before a request, and writes nothing", async () => {
    const none = setup({ target: () => undefined });
    const early = setup();
    const early2 = setup({ target: () => ({ path: early.path, requested: false }) });

    await expect(none.save("x")).resolves.toEqual({
      text: "Error: no handoff was requested; continue your task.",
      isError: true,
    });
    await expect(early2.save("x")).resolves.toMatchObject({ isError: true });
    expect(existsSync(early.path)).toBe(false);
    expect(none.onSaved).not.toHaveBeenCalled();
    expect(early2.onSaved).not.toHaveBeenCalled();
  });

  it("writes the trimmed content with a trailing newline, creating the directory, and reports a valid save", async () => {
    const { path, onSaved, save } = setup();

    const result = await save("  ## Status\npartial \n\n");

    expect(result).toEqual({ text: `Handoff saved at ${path}` });
    expect(readFileSync(path, "utf8")).toBe("## Status\npartial\n");
    expect(onSaved).toHaveBeenCalledWith("## Status\npartial", ok);
  });

  it("keeps an invalid save, returns its errors as an error result and still reports it", async () => {
    const invalid: HandoffValidation = {
      ok: false,
      errors: ["missing sections: Next", "empty sections: Blocker"],
    };
    const { path, onSaved, save } = setup({ validate: () => invalid });

    const result = await save("## Status\npartial");

    expect(result).toEqual({
      text: `Handoff saved at ${path} but it is invalid: missing sections: Next; empty sections: Blocker. Fix the sections and call handoff again.`,
      isError: true,
    });
    expect(readFileSync(path, "utf8")).toBe("## Status\npartial\n");
    expect(onSaved).toHaveBeenCalledWith("## Status\npartial", invalid);
  });

  it("returns a write failure as an error result without reporting a save", async () => {
    const blocker = join(temp.make("pi-handoff-tool-"), "file");

    writeFileSync(blocker, "x");

    const path = join(blocker, "main-handoff.md");
    const { onSaved, save } = setup({ target: () => ({ path, requested: true }) });

    const result = await save("text");

    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain(`Error: handoff not saved at ${path}:`);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
