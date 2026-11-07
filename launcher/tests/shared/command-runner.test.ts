import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";

const runner = createProcessRunner();

const node = process.execPath;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
    const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-runner-"));
    const script =
      "process.stdout.write(JSON.stringify([process.cwd(), process.env.EXTRA, !!process.env.PATH]))";

    dirs.push(cwd);

    const result = await runner.run(node, ["-e", script], { cwd, env: { EXTRA: "yes" } });

    expect(JSON.parse(result.stdout)).toEqual([await realpath(cwd), "yes", true]);
  });

  it("reports a signal as 128 plus the signal number", async () => {
    const script = "process.kill(process.pid, 'SIGTERM')";

    expect((await runner.run(node, ["-e", script])).code).toBe(143);
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
