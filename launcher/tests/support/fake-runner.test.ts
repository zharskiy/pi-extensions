import { describe, expect, it } from "vitest";
import { LauncherError } from "../../shared/index.ts";
import { createFakeRunner } from "./fake-runner.ts";

describe("createFakeRunner", () => {
  it("answers run with the scripted result and defaults for the rest", async () => {
    const { runner } = createFakeRunner(() => ({ stdout: "v1\n" }));

    expect(await runner.run("git", ["--version"])).toEqual({ code: 0, stdout: "v1\n", stderr: "" });
  });

  it("answers spawnInteractive with the scripted exit code", async () => {
    const { runner } = createFakeRunner(() => ({ code: 7 }));

    expect(await runner.spawnInteractive("container", ["exec"])).toBe(7);
  });

  it("records every command it was asked to run", async () => {
    const { runner, calls } = createFakeRunner(() => ({}));

    await runner.run("git", ["status"], { cwd: "/repo" });

    await runner.spawnInteractive("pi", []);

    expect(calls).toEqual([
      { file: "git", args: ["status"], options: { cwd: "/repo" }, interactive: false },
      { file: "pi", args: [], options: {}, interactive: true },
    ]);
  });

  it("rejects like a missing command when the responder has no answer", async () => {
    const { runner } = createFakeRunner(() => undefined);

    await expect(runner.run("colima", ["status"])).rejects.toBeInstanceOf(LauncherError);
  });
});
