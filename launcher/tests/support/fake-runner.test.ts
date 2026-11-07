import { describe, expect, it } from "vitest";
import { LauncherError } from "../../shared/index.ts";
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
