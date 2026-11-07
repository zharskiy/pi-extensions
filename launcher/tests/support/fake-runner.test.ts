import { describe, expect, it } from "vitest";
import { LauncherError } from "../../shared/index.ts";
import { argvOf, createFakeRunner, createScriptedRunner } from "./fake-runner.ts";

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

  it("records env, cwd and input of each call", async () => {
    const { runner, calls } = createFakeRunner(() => ({}));

    await runner.run("pi", ["mcp", "list"], {
      cwd: "/tmp/empty",
      env: { PI_CODING_AGENT_DIR: "/state" },
      input: "y",
    });

    expect(calls[0]?.options).toEqual({
      cwd: "/tmp/empty",
      env: { PI_CODING_AGENT_DIR: "/state" },
      input: "y",
    });
    expect(argvOf(calls[0] ?? { file: "", args: [], options: {}, interactive: false })).toEqual([
      "pi",
      "mcp",
      "list",
    ]);
  });

  it("waits for an asynchronous responder", async () => {
    const { runner } = createFakeRunner(async () => ({ stdout: "late" }));

    expect((await runner.run("sso", [])).stdout).toBe("late");
  });
});

describe("createScriptedRunner", () => {
  it("answers by the first script whose argv is a prefix of the call", async () => {
    const { runner } = createScriptedRunner([
      { argv: ["pi", "auth", "print-api-key"], result: { stdout: "key\n" } },
      { argv: ["pi", "auth"], result: { code: 2, stderr: "usage" } },
      { argv: ["security"], respond: (call) => ({ stdout: call.args.join(" ") }) },
    ]);

    expect(await runner.run("pi", ["auth", "print-api-key", "--provider", "corp"])).toEqual({
      code: 0,
      stdout: "key\n",
      stderr: "",
    });
    expect((await runner.run("pi", ["auth", "print-bearer-token"])).code).toBe(2);
    expect((await runner.run("security", ["find-generic-password", "-w"])).stdout).toBe(
      "find-generic-password -w",
    );
  });

  it("falls back to the given responder, or a missing command", async () => {
    const scripted = createScriptedRunner([], () => ({ code: 9 }));
    const bare = createScriptedRunner([{ argv: ["git"] }]);

    expect((await scripted.runner.run("tar", [])).code).toBe(9);
    expect((await bare.runner.run("git", ["status"])).code).toBe(0);
    await expect(bare.runner.run("npm", [])).rejects.toBeInstanceOf(LauncherError);
  });
});
