import { describe, expect, it } from "vitest";
import { checkMcpAuthSweep } from "../../cli/commands/doctor-probes.ts";
import { runningContainer, tempDir } from "../provision/fixtures.ts";
import { createFakeBackend } from "../support/fake-backend.ts";

const targetWith = async (exec: () => Promise<number>) => {
  const fake = createFakeBackend({ guestAgentDir: await tempDir("doctor-probes") });
  const containerId = await runningContainer(fake.backend);

  fake.backend.exec = exec;

  return { backend: fake.backend, containerId, workdir: "/" };
};

describe("checkMcpAuthSweep", () => {
  it("fails with the reason when mcp-auth.json cannot be read", async () => {
    const refused = await targetWith(() => Promise.reject(new Error("engine gone")));
    const exited = await targetWith(() => Promise.resolve(2));

    expect(await checkMcpAuthSweep(refused)).toMatchObject({
      status: "fail",
      detail: "mcp-auth.json: could not read it from the sandbox volume: engine gone",
    });
    expect(await checkMcpAuthSweep(exited)).toMatchObject({
      status: "fail",
      detail: "mcp-auth.json: could not read it from the sandbox volume (exit 2)",
    });
  });
});
