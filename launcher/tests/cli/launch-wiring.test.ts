import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProxyRouteRequest } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import type { DenialRecord } from "../../proxy/index.ts";
import { isPlaceholder, sha256Hex } from "../../shared/index.ts";
import { expectNoLeak } from "../support/expect-no-leak.ts";
import { writeExecutable, writeText } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, noHostPiLine, renderDirOf } from "./harness.ts";

const REAL_KEY = "real-secret-value-1234567890";

const PINNED = `sha256:${"a".repeat(64)}`;

const denial = (host: string, port: number, rule = "egress.allow", reason = "not allowed"): DenialRecord => ({
  time: 1_700_000_000_500,
  host,
  port,
  repoHash: "repo",
  rule,
  reason,
});

describe("pi launch wiring", () => {
  it("gives the container and its proxy the same repository token and labels the container with its hash", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = fake.created;
    const url = new URL(container?.spec?.env.HTTPS_PROXY ?? "");
    const [input] = harness.proxyInputs;

    expect(url.password).toMatch(/^[0-9a-f]{64}$/);
    expect(url.hostname).toBe("pi-sandbox-proxy");
    expect(input?.token).toBe(url.password);
    expect(input).toMatchObject({
      repoHash: sha256Hex(harness.repoRoot),
      rules: [],
      derivedHosts: expect.any(Array),
    });
  });

  it("hands env secrets to the proxy, not to the container", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pi-sandbox:1": PINNED } });
    const harness = await createHarness({
      backend: () => fake.backend,
      env: { CORP_TOKEN: REAL_KEY },
    });

    await harness.writeJson(harness.userConfigFile, {
      credentials: {
        rules: [
          {
            id: "corp",
            host: "corp.example.test",
            placeholder: "pi-sandbox-corp",
            secret: { env: "CORP_TOKEN" },
          },
        ],
      },
      image: { reference: "registry.example.test/pi-sandbox:1", digest: PINNED },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.proxyInputs.map((input) => input.envSecrets)).toEqual([{ corp: REAL_KEY }]);

    await expectNoLeak(fake, renderDirOf(harness), [REAL_KEY]);
  });

  it("hands the env parent proxy's credentials to the proxy input and its address without them", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pi-sandbox:1": PINNED } });
    const harness = await createHarness({
      backend: () => fake.backend,
      env: { HTTPS_PROXY: "http://corp:p%40ss@proxy.example.test:8080" },
    });

    await harness.writeJson(harness.userConfigFile, {
      image: { reference: "registry.example.test/pi-sandbox:1", digest: PINNED },
    });

    expect(await run([], harness.deps)).toBe(0);

    expect(harness.proxyInputs.map((input) => input.parentAuth)).toEqual(["corp:p@ss"]);
    expect(harness.proxyInputs.map((input) => input.parentEnv.HTTPS_PROXY)).toEqual([
      "http://proxy.example.test:8080",
    ]);

    await expectNoLeak(fake, renderDirOf(harness), ["p@ss", "p%40ss"]);
  });

  it("renders Maven proxy settings and hands the proxy to JVMs on a host without ~/.m2/settings.xml", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await expect(lstat(join(harness.deps.home, ".m2", "settings.xml"))).rejects.toThrow();
    expect(await run([], harness.deps)).toBe(0);

    const [container] = fake.created;
    const env = container?.spec?.env ?? {};
    const token = new URL(env.HTTPS_PROXY ?? "").password;
    const settings = await readFile(join(renderDirOf(harness), "tools", "m2-settings.xml"), "utf8");

    expect(settings).toMatch(/<proxy>[\s\S]*<host>\$\{env\.PI_SANDBOX_PROXY_HOST\}<\/host>[\s\S]*<\/proxy>/);
    expect(env).toMatchObject({
      https_proxy: env.HTTPS_PROXY,
      PI_SANDBOX_PROXY_HOST: "pi-sandbox-proxy",
      PI_SANDBOX_PROXY_TOKEN: token,
      PIP_CERT: "/tmp/pi-sandbox/ca-bundle.pem",
    });
    expect(env.JAVA_TOOL_OPTIONS).toContain("-Dhttps.proxyHost=pi-sandbox-proxy");
    expect(env.JAVA_TOOL_OPTIONS).not.toContain("trustStore");

    await expectNoLeak(fake, renderDirOf(harness), [REAL_KEY]);
  });

  it("gives gh and git placeholders for the host gh token and the proxy a gh command rule", async () => {
    const fake = createFakeBackend();
    const ghToken = "gho_REAL-HOST-GH-TOKEN-31337";
    const harness = await createHarness({
      backend: () => fake.backend,
      respond: (call) =>
        call.file.endsWith("/gh") && call.args[0] === "--version"
          ? { stdout: "gh version 2.45.0\n" }
          : undefined,
    });
    const gh = join(harness.root, "bin", "gh");

    await writeExecutable(gh);

    await writeText(
      join(harness.deps.home, ".config", "gh", "hosts.yml"),
      `github.com:\n    oauth_token: ${ghToken}\n    user: me\n`,
    );

    harness.deps.env.PATH = join(harness.root, "bin");

    expect(await run([], harness.deps)).toBe(0);

    const env = fake.created[0]?.spec?.env ?? {};
    const [input] = harness.proxyInputs;
    const renderDir = renderDirOf(harness);
    const tools = join(renderDir, "tools");

    expect(isPlaceholder(env.GH_TOKEN ?? "")).toBe(true);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(Object.keys(env).filter((name) => name.startsWith("GIT_CONFIG"))).toEqual([]);
    expect(input?.rules.filter((rule) => rule.id === "derived:gh:github.com:token")).toEqual(
      ["github.com", "api.github.com", "uploads.github.com"].map((host) => ({
        id: "derived:gh:github.com:token",
        host,
        placeholder: env.GH_TOKEN,
        secret: { command: [gh, "auth", "token", "--hostname", "github.com"] },
      })),
    );
    expect(input?.derivedHosts).toEqual(expect.arrayContaining(["api.github.com", "uploads.github.com"]));
    expect(await readFile(join(tools, "gh-hosts.yml"), "utf8")).toContain(`oauth_token: "${env.GH_TOKEN}"`);
    expect(await readFile(join(tools, "gitconfig"), "utf8")).toContain(
      `printf 'username=%s\\\\npassword=%s\\\\n' 'x-access-token' '${env.GH_TOKEN}'`,
    );

    await expectNoLeak(fake, renderDir, [ghToken]);
  });

  it("gives glab placeholders for gitlab.com and a self-managed host and no GITLAB_TOKEN for two hosts", async () => {
    const fake = createFakeBackend();
    const glabToken = "glpat-REAL-HOST-GLAB-TOKEN-4242";
    const harness = await createHarness({
      backend: () => fake.backend,
      respond: (call) =>
        call.file.endsWith("/glab") && call.args[0] === "config" ? { stdout: `${glabToken}\n` } : undefined,
    });
    const glab = join(harness.root, "bin", "glab");

    await writeExecutable(glab);

    await writeText(
      join(harness.deps.home, ".config", "glab-cli", "config.yml"),
      [
        "hosts:",
        "    gitlab.com:",
        `        token: ${glabToken}`,
        "        user: me",
        "    gitlab.corp.test:",
        `        token: ${glabToken}`,
        "        api_host: api.gitlab.corp.test",
        "        user: me",
        "",
      ].join("\n"),
    );

    harness.deps.env.PATH = join(harness.root, "bin");

    expect(await run([], harness.deps)).toBe(0);

    const env = fake.created[0]?.spec?.env ?? {};
    const [input] = harness.proxyInputs;
    const renderDir = renderDirOf(harness);
    const config = await readFile(join(renderDir, "tools", "glab-config.yml"), "utf8");
    const corpRules = input?.rules.filter((rule) => rule.id === "derived:glab:gitlab.corp.test:token") ?? [];

    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.GITLAB_HOST).toBeUndefined();
    expect(corpRules.map((rule) => rule.host)).toEqual(["gitlab.corp.test", "api.gitlab.corp.test"]);
    expect(corpRules[0]?.secret).toEqual({
      command: [glab, "config", "get", "token", "--host", "gitlab.corp.test"],
    });
    const comRules = input?.rules.filter((rule) => rule.id === "derived:glab:gitlab.com:token") ?? [];

    expect(comRules.map((rule) => rule.host)).toEqual(["gitlab.com"]);
    expect(config).toContain(`    gitlab.com:\n        token: "${comRules[0]?.placeholder}"`);
    expect(config).toContain(`    gitlab.corp.test:\n        token: "${corpRules[0]?.placeholder}"`);
    expect(await readFile(join(renderDir, "tools", "gitconfig"), "utf8")).toContain(
      '[credential "https://gitlab.corp.test"]',
    );

    await expectNoLeak(fake, renderDir, [glabToken]);
  });

  it("renders host auth.json with placeholders into a read-only render mount", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), {
      example: { type: "api_key", key: REAL_KEY },
    });

    await run([], harness.deps);

    const [container] = fake.created;
    const renderDir = renderDirOf(harness);
    const rendered = await readFile(join(renderDir, "auth.json"), "utf8");

    expect(container?.spec?.mounts).toContainEqual({
      source: renderDir,
      target: "/opt/pi-sandbox/render",
      readOnly: true,
      kind: "bind",
    });
    expect(JSON.parse(rendered).example.key).toMatch(/^pi-sandbox-[0-9a-f]{24}$/);

    await expectNoLeak(fake, renderDir, [REAL_KEY]);
  });

  it("leaves a secrets directory of a host skill out of the render dir and says so once per repository", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await writeText(join(harness.hostAgentDir, "skills", "deploy", "SKILL.md"), "# deploy\n");

    await writeText(join(harness.hostAgentDir, "skills", "deploy", "secrets", "prod.txt"), REAL_KEY);

    expect(await run([], harness.deps)).toBe(0);

    const renderDir = renderDirOf(harness);

    expect(await readFile(join(renderDir, "skills", "deploy", "SKILL.md"), "utf8")).toBe("# deploy\n");
    expect(harness.stderr()).toContain(
      "render: skills/deploy/secrets looks like a secrets directory and stays out of the sandbox",
    );

    await expectNoLeak(fake, renderDir, [REAL_KEY]);

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr().split("looks like a secrets directory").length - 1).toBe(1);
  });

  it("prints one line per denied host when pi exits", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      denials: [
        denial("blocked.example.test", 443),
        denial("blocked.example.test", 443),
        denial("other.test", 8443),
      ],
    });

    await run([], harness.deps);

    expect(harness.stderr()).toContain(
      `pi-sandbox: blocked.example.test was blocked in this folder's sandbox; run pi sandbox egress allow blocked.example.test on the host from ${harness.repoRoot}\n`,
    );
    expect(harness.stderr()).toContain(
      `pi-sandbox: other.test:8443 was blocked in this folder's sandbox; run pi sandbox egress allow other.test:8443 on the host from ${harness.repoRoot}\n`,
    );
    expect(harness.stderr().match(/blocked\.example\.test was blocked/g)).toHaveLength(1);
  });

  it.each([
    [
      "a private address",
      denial(
        "nexus.corp.test",
        443,
        "private-address",
        "nexus.corp.test resolves only to restricted addresses (10.1.2.3 is a private network address)",
      ),
      "nexus.corp.test resolves only to restricted addresses (10.1.2.3 is a private network address); add nexus.corp.test to egress.privateHosts in",
    ],
  ])("names the user config to edit for %s when pi exits", async (_kind, record, hint) => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend, denials: [record] });

    await run([], harness.deps);

    expect(harness.stderr()).toContain(
      `pi-sandbox: ${record.host} was blocked in this folder's sandbox; ${hint} ${harness.userConfigFile}\n`,
    );
  });

  it.each([
    ["an IP address", denial("10.1.2.3", 443, "private-address", "10.1.2.3 is a private network address")],
    ["a loopback name", denial("localhost", 8443, "loopback", "localhost is a loopback name")],
  ])("does not suggest egress.privateHosts for %s, which it rejects", async (_kind, record) => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend, denials: [record] });

    await run([], harness.deps);

    expect(harness.stderr()).toContain(
      `; ${record.reason}; IP addresses and loopback names are never reachable from the sandbox; use a host name\n`,
    );
    expect(harness.stderr()).not.toContain("egress.privateHosts");
  });

  it.each([
    [
      "an unavailable credential",
      denial("api.corp.test", 443, "credential", "credential corp is unavailable: token expired"),
      "pi-sandbox: api.corp.test was blocked in this folder's sandbox; it could not authenticate: credential corp is unavailable: token expired\n",
    ],
    [
      "a missing or expired host login",
      denial("llm.corp.test", 443, "login", "the corp-llm login on the host is missing or expired"),
      "pi-sandbox: llm.corp.test was blocked in this folder's sandbox; the corp-llm login on the host is missing or expired; log in again with pi --no-sandbox and /login\n",
    ],
    [
      "egress.deny",
      denial("paste.test", 443, "egress.deny", "paste.test is in egress.deny"),
      "pi-sandbox: paste.test was blocked in this folder's sandbox; denied by egress.deny\n",
    ],
    [
      "plain HTTP",
      denial("localhost.test", 80, "plain-http", "only HTTPS through CONNECT is proxied"),
      "pi-sandbox: localhost.test:80 was blocked in this folder's sandbox; plain HTTP is not proxied; use https\n",
    ],
    [
      "an upstream failure",
      denial("down.test", 443, "upstream", "connect ECONNREFUSED 203.0.113.9:443"),
      "pi-sandbox: down.test was blocked in this folder's sandbox; it could not be reached: connect ECONNREFUSED 203.0.113.9:443\n",
    ],
    [
      "a TLS name mismatch",
      denial("api.test", 443, "sni", "TLS server name evil.test does not match api.test"),
      "pi-sandbox: api.test was blocked in this folder's sandbox; TLS server name evil.test does not match api.test\n",
    ],
  ])("prints its own hint for %s when pi exits", async (_kind, record, line) => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend, denials: [record] });

    await run([], harness.deps);

    expect(harness.stderr()).toContain(line);
    expect(harness.stderr()).not.toContain("egress allow");
  });

  it("prints derivation notices on stderr, one line each", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend, hostPi: false });

    await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
      mcpServers: { docs: { url: "https://docs.example.test/mcp" } },
    });

    await run([], harness.deps);

    expect(harness.stderr()).toContain("pi-sandbox: mcp docs: not signed in; run pi mcp login docs\n");
    expect(harness.stderr()).toContain(`pi-sandbox: ${noHostPiLine(harness.hostAgentDir)}\n`);
  });
});

describe("the proxy route of a repository", () => {
  it("asks the backend for the repository's own network", async () => {
    const fake = createFakeBackend();
    const asked: Array<string | undefined> = [];
    const backend = {
      ...fake.backend,
      prepareProxyRoute: (request: ProxyRouteRequest) => {
        asked.push(request.repoHash);

        return fake.backend.prepareProxyRoute(request);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked).toEqual([sha256Hex(harness.repoRoot)]);
  });
});
