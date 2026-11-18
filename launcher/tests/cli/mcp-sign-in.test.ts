import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { mcpAuthKey, stateLayout, withFileLock } from "../../shared/index.ts";
import type { FakeCall } from "../support/fake-runner.ts";
import { createFakeBackend, createHarness, doctorCheck } from "./harness.ts";

const URL_TEXT = "https://docs.example.test/mcp";

const KEY = mcpAuthKey("docs", URL_TEXT);

const isLogin = (call: FakeCall) => call.interactive && call.args.slice(1, 3).join(" ") === "mcp login";

const harnessWith = async (
  options: { tty?: boolean; stdoutTty?: boolean; loginExit?: number; store?: unknown } = {},
) => {
  const fake = createFakeBackend();
  const containersAtLogin: number[] = [];
  const harness = await createHarness({
    backend: () => fake.backend,
    respond: (call) => {
      if (!isLogin(call)) {
        return undefined;
      }

      containersAtLogin.push(fake.containers.size);

      return { code: options.loginExit ?? 0 };
    },
  });

  (harness.deps.terminal.stdin as { isTTY?: boolean }).isTTY = options.tty ?? true;
  (harness.deps.terminal.stdout as { isTTY?: boolean }).isTTY = options.stdoutTty ?? options.tty ?? true;

  await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
    mcpServers: { docs: { url: URL_TEXT } },
  });

  if (options.store !== undefined) {
    await harness.writeJson(join(harness.hostAgentDir, "mcp-auth.json"), options.store);
  }

  const logins = () => harness.calls.filter(isLogin);

  return { harness, fake, logins, containersAtLogin };
};

const loginRecord = async (stateDir: string) =>
  (
    JSON.parse(await readFile(stateLayout(stateDir).mcpLogin, "utf8")) as Record<
      string,
      { failedAt?: number }
    >
  )[KEY];

describe("MCP sign-in at launch start", () => {
  it("runs one interactive host login for a server without a token before the container starts", async () => {
    const { harness, logins, containersAtLogin } = await harnessWith();

    expect(await run([], harness.deps)).toBe(0);

    const [login] = logins();

    expect(logins()).toHaveLength(1);
    expect(login?.args.slice(1)).toEqual(["mcp", "login", "docs", "--timeout", "300"]);
    expect(login?.options.env).toEqual({ PI_CODING_AGENT_DIR: harness.hostAgentDir });
    expect(login?.options.cwd?.startsWith(harness.repoRoot)).toBe(false);
    expect(containersAtLogin).toEqual([0]);
    expect(harness.stderr()).toContain("pi-sandbox: mcp docs: signing in on the host; your browser opens\n");
  });

  it("starts no login from pi sandbox doctor, even from a terminal, and names the login command", async () => {
    const { harness, logins } = await harnessWith();

    await run(["sandbox", "doctor"], harness.deps);

    expect(logins()).toEqual([]);
    expect(harness.stderr()).not.toContain("signing in on the host");
    expect(doctorCheck(harness.stdout(), "mcp docs")).toMatchObject({
      status: "warn",
      detail: "needs sign-in",
      hint: "run pi mcp login docs",
    });
  });

  it("starts no login when a refresh token is stored", async () => {
    const { harness, logins } = await harnessWith({
      store: { [KEY]: { tokens: { access_token: "a", refresh_token: "r" }, tokensExpireAt: 1 } },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(logins()).toEqual([]);
    expect(harness.stderr()).not.toContain("mcp docs");
  });

  it("records a failed login, does not retry it at launch start for 24 h and says so once", async () => {
    const { harness, logins } = await harnessWith({ loginExit: 1 });

    expect(await run([], harness.deps)).toBe(0);
    expect((await loginRecord(harness.stateDir))?.failedAt).toBe(harness.deps.now());
    expect(await run([], harness.deps)).toBe(0);
    expect(logins()).toHaveLength(1);
    expect(
      harness.stderr().split("pi-sandbox: mcp docs: not signed in; run pi mcp login docs\n"),
    ).toHaveLength(2);

    const later = harness.deps.now() + 24 * 3_600_000 + 1;

    harness.deps.now = () => later;

    expect(await run([], harness.deps)).toBe(0);
    expect(logins()).toHaveLength(2);
  });

  it("clears an earlier failure once a login succeeds", async () => {
    const { harness, logins } = await harnessWith();
    const earlier = harness.deps.now() - 25 * 3_600_000;

    await harness.writeJson(stateLayout(harness.stateDir).mcpLogin, { [KEY]: { failedAt: earlier } });

    expect(await run([], harness.deps)).toBe(0);
    expect(logins()).toHaveLength(1);
    expect((await loginRecord(harness.stateDir))?.failedAt).toBeUndefined();
  });

  it("prints a notice and starts no second login while a proxy login holds the lock", async () => {
    const { harness, logins } = await harnessWith();
    const release: { now?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      release.now = resolve;
    });
    const holding = withFileLock(stateLayout(harness.stateDir).mcpLoginLock(KEY), () => held);

    expect(await run([], harness.deps)).toBe(0);

    release.now?.();

    await holding;

    expect(logins()).toEqual([]);
    expect(harness.stderr()).toContain("pi-sandbox: mcp docs: a sign-in is already open on the host\n");
  });

  it("prints only a notice when the output is not a terminal", async () => {
    const { harness, logins } = await harnessWith({ stdoutTty: false });

    expect(await run([], harness.deps)).toBe(0);
    expect(logins()).toEqual([]);
    expect(harness.stderr()).toContain("pi-sandbox: mcp docs: not signed in; run pi mcp login docs\n");
  });

  it("prints only a notice without a terminal", async () => {
    const { harness, logins } = await harnessWith({ tty: false });

    expect(await run([], harness.deps)).toBe(0);
    expect(logins()).toEqual([]);
    expect(harness.stderr()).toContain("pi-sandbox: mcp docs: not signed in; run pi mcp login docs\n");
  });
});
