import { describe, expect, it } from "vitest";
import type { ExecIo, ExecSpec } from "../../backend/index.ts";
import { checkMcpAuthSweep, sweepCredentials } from "../../cli/commands/doctor-probes.ts";
import { runningContainer, tempDir } from "../provision/fixtures.ts";
import { createFakeBackend } from "../support/fake-backend.ts";

const targetWith = async (exec: (spec: ExecSpec, io: ExecIo) => Promise<number>) => {
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

describe("sweepCredentials", () => {
  const TOKEN = "a".repeat(64);

  const envOf = (text: string) =>
    targetWith(async (spec, io) => {
      if (spec.command[0] !== "env") {
        return 1;
      }

      io.stdout.write(text);

      return 0;
    });

  it("fails on any variable that holds the proxy token, whatever its name", async () => {
    const target = await envOf(`TERM=xterm\nHTTPS_PROXY=http://pi-sandbox:${TOKEN}@pi-sandbox-proxy:3128\n`);

    expect(await sweepCredentials(target, TOKEN)).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining([
        "environment variable HTTPS_PROXY holds the proxy token, which only the relay may hold",
      ]),
    });
  });

  it("passes an environment whose proxy URL carries no token", async () => {
    const target = await envOf("TERM=xterm\nHTTPS_PROXY=http://pi-sandbox-proxy:3128\n");

    expect(await sweepCredentials(target, TOKEN)).toMatchObject({ status: "ok" });
  });
});
