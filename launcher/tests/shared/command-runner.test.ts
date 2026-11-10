import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createProcessRunner, LauncherError, withResolvedCommand } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const runner = createProcessRunner();

const node = process.execPath;

describe("createProcessRunner run", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";

    expect(await runner.run(node, ["-e", script])).toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  it("feeds the input to stdin", async () => {
    const script = "process.stdin.pipe(process.stdout)";

    expect((await runner.run(node, ["-e", script], { input: "hello" })).stdout).toBe("hello");
  });

  it("runs in the given cwd with the extra env on top of the host env", async () => {
    const cwd = await tempDir("runner");
    const script =
      "process.stdout.write(JSON.stringify([process.cwd(), process.env.EXTRA, !!process.env.PATH]))";

    const result = await runner.run(node, ["-e", script], { cwd, env: { EXTRA: "yes" } });

    expect(JSON.parse(result.stdout)).toEqual([await realpath(cwd), "yes", true]);
  });

  it("reports a signal as 128 plus the signal number", async () => {
    const script = "process.kill(process.pid, 'SIGTERM')";

    expect((await runner.run(node, ["-e", script])).code).toBe(143);
  });

  it("kills a child that outlives the timeout and reports code 124 with the output so far", async () => {
    const script = "process.stdout.write('started'); setInterval(() => undefined, 1000)";
    const begun = Date.now();
    const result = await runner.run(node, ["-e", script], { timeoutMs: 500 });

    expect(result).toEqual({ code: 124, timedOut: true, stdout: "started", stderr: "" });
    expect(Date.now() - begun).toBeLessThan(5000);
  });

  it("returns the normal result when the child ends within the timeout", async () => {
    expect(await runner.run(node, ["-e", "process.exit(2)"], { timeoutMs: 10_000 })).toEqual({
      code: 2,
      stdout: "",
      stderr: "",
    });
  });

  it("rejects with a LauncherError naming a missing command", async () => {
    const result = runner.run("pi-sandbox-missing-command", []);

    await expect(result).rejects.toBeInstanceOf(LauncherError);
    await expect(result).rejects.toThrow("pi-sandbox-missing-command: command not found");
  });
});

describe("createProcessRunner spawnInteractive", () => {
  it("resolves with the exit code of the child", async () => {
    expect(await runner.spawnInteractive(node, ["-e", "process.exit(4)"])).toBe(4);
  });

  it("rejects with a LauncherError naming a missing command", async () => {
    await expect(runner.spawnInteractive("pi-sandbox-missing-command", [])).rejects.toThrow(
      "pi-sandbox-missing-command: command not found",
    );
  });
});

describe("createProcessRunner with a base env", () => {
  it("starts children from the base env instead of the host env", async () => {
    const script =
      "process.stdout.write(JSON.stringify([process.env.BASE, process.env.EXTRA, process.env.HOME]))";
    const isolated = createProcessRunner({ baseEnv: { BASE: "kept", PATH: process.env.PATH ?? "" } });
    const result = await isolated.run(node, ["-e", script], { env: { EXTRA: "yes" } });

    expect(JSON.parse(result.stdout)).toEqual(["kept", "yes", null]);
  });
});

describe("withResolvedCommand", () => {
  it("runs the bare name as the path found once, and fails as not found without one", async () => {
    const calls: string[] = [];
    const lookups: string[] = [];
    const base = {
      run: async (file: string) => {
        calls.push(file);

        return { code: 0, stdout: "", stderr: "" };
      },
      spawnInteractive: async (file: string) => {
        calls.push(file);

        return 0;
      },
    };
    const found = withResolvedCommand(base, "git", async () => {
      lookups.push("git");

      return "/usr/bin/git";
    });

    await found.run("git", []);
    await found.spawnInteractive("git", []);
    await found.run("colima", []);

    expect(calls).toEqual(["/usr/bin/git", "/usr/bin/git", "colima"]);
    expect(lookups).toEqual(["git"]);

    const missing = withResolvedCommand(base, "git", async () => undefined);

    await expect(missing.run("git", [])).rejects.toThrow("git: command not found");
  });
});
