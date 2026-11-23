import { describe, expect, it } from "vitest";
import type { ExecIo, ExecSpec } from "../../backend/index.ts";
import { checkMcp, checkMcpAuthSweep, sweepCredentials } from "../../cli/commands/doctor-probes.ts";
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

const ESC = String.fromCharCode(27);

const MCP_LIST = [
  "docs: connected, 3 tools (direct, user)",
  "  stdio npx -y docs-server",
  "  tools: search, fetch, list",
  `${ESC}[32mmy server.v2${ESC}[0m: connected, 1 tool (search, project)`,
  "  http https://mcp.example.test/",
  "  tools: lookup",
  "  team/notes: connected, 0 tools (direct, user)",
  "  stdio notes",
  "drafts: needs sign-in (direct, user)",
  "  http https://drafts.example.test/",
  "  sign in with: pi mcp login drafts",
  "",
].join("\n");

describe("checkMcp", () => {
  it("counts the servers pi mcp list reports connected, whatever their names, ignoring colour and indentation", async () => {
    const target = await targetWith(async (_spec, io) => {
      io.stdout.write(MCP_LIST);

      return 0;
    });

    expect(await checkMcp(target)).toMatchObject({
      status: "ok",
      brief: "3 MCP servers connect from the sandbox",
    });
  });

  it("leaves the count out when no server is connected", async () => {
    const target = await targetWith(async (_spec, io) => {
      io.stdout.write(
        "No MCP servers configured. Add them to /home/pi/.pi/agent/mcp.json or .pi/mcp.json.\n",
      );

      return 0;
    });

    expect((await checkMcp(target)).brief).toBeUndefined();
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
        "environment variable HTTPS_PROXY holds the proxy token, which belongs to the proxy, never to the sandbox",
      ]),
    });
  });

  it("passes an environment whose proxy URL carries no token", async () => {
    const target = await envOf("TERM=xterm\nHTTPS_PROXY=http://pi-sandbox-proxy:3128\n");

    expect(await sweepCredentials(target, TOKEN)).toMatchObject({ status: "ok" });
  });

  const GIT_REWRITE = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "url.https://git.example.internal/.insteadOf",
    GIT_CONFIG_VALUE_0: "git@git.example.internal:",
    GIT_CONFIG_KEY_1: "url.https://git.example.internal/.insteadOf",
    GIT_CONFIG_VALUE_1: "ssh://git@git.example.internal/",
  };

  const envText = (env: Record<string, string>) =>
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}\n`)
      .join("");

  it("passes the env.set values of the config and names the secret-looking ones it did not check", async () => {
    const target = await envOf(`TERM=xterm\n${envText(GIT_REWRITE)}`);

    expect(await sweepCredentials(target, TOKEN, GIT_REWRITE)).toEqual({
      status: "ok",
      detail:
        "no credential in the environment, auth.json or mcp.json; env.set values not checked: GIT_CONFIG_KEY_0, GIT_CONFIG_KEY_1",
      brief: "env.set values not checked: GIT_CONFIG_KEY_0, GIT_CONFIG_KEY_1",
    });
  });

  it("passes and names a token that env.set sets to the value inside", async () => {
    const configured = { NPM_TOKEN: "npm_real" };
    const target = await envOf(envText(configured));

    expect(await sweepCredentials(target, TOKEN, configured)).toMatchObject({
      status: "ok",
      detail:
        "no credential in the environment, auth.json or mcp.json; env.set values not checked: NPM_TOKEN",
    });
  });

  it("keeps the passing detail when env.set sets no secret-looking name", async () => {
    const configured = { CI: "1" };
    const target = await envOf(`TERM=xterm\n${envText(configured)}`);

    expect(await sweepCredentials(target, TOKEN, configured)).toMatchObject({
      status: "ok",
      detail: "no credential in the environment, auth.json or mcp.json",
    });
  });

  it("fails an env.set name whose value inside differs from the config", async () => {
    const target = await envOf(envText({ ...GIT_REWRITE, GIT_CONFIG_KEY_0: "real-secret-value-1234567890" }));

    expect(await sweepCredentials(target, TOKEN, GIT_REWRITE)).toMatchObject({
      status: "fail",
      reasons: ["environment variable GIT_CONFIG_KEY_0 holds a value other than the placeholder"],
    });
  });

  it("fails a secret-named variable that env.set does not set", async () => {
    const target = await envOf(`${envText(GIT_REWRITE)}GATEWAY_API_KEY=real-secret-value-1234567890\n`);

    expect(await sweepCredentials(target, TOKEN, GIT_REWRITE)).toMatchObject({
      status: "fail",
      reasons: ["environment variable GATEWAY_API_KEY holds a value other than the placeholder"],
    });
  });
});
