import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LauncherError } from "../../shared/index.ts";
import { createFakeBackend } from "./fake-backend.ts";
import { createFakeRunner } from "./fake-runner.ts";

describe("createFakeRunner", () => {
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
  });
});

describe("createFakeBackend exec", () => {
  it("records a stdin stream also when a custom exec handles the call", async () => {
    const stdin = new PassThrough();
    const out = new PassThrough();
    const fake = createFakeBackend({
      exec: async (_spec, io) => {
        stdin.end("typed");

        await new Promise((resolve) => io.stdin?.once("end", resolve));

        return 5;
      },
    });

    expect(
      await fake.backend.exec(
        { containerId: "c1", env: {}, workdir: "/", command: ["sh"] },
        { stdin, stdout: out, stderr: out, tty: false },
      ),
    ).toBe(5);
    expect(fake.execs[0]?.stdin.map(String).join("")).toBe("typed");
  });
});
