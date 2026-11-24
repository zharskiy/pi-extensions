import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS, type RelayRequest } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import type { DenialRecord } from "../../proxy/index.ts";
import { repoHash, sha256Hex, writeRepoRecord } from "../../shared/index.ts";
import { expectNoLeak } from "../support/expect-no-leak.ts";
import { tempDir, writeExecutable, writeText } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, isPiSession, noHostPiLine, renderDirOf } from "./harness.ts";

const REAL_KEY = "real-secret-value-1234567890";

const PINNED = `sha256:${"a".repeat(64)}`;

const denial = (host: string, port: number, rule = "egress.allow", reason = "not allowed"): DenialRecord => ({
  time: 1_700_000_000_500,
  host,
  port,
  rule,
  reason,
});

describe("pi launch wiring", () => {
  it("gives the relay, not the container, the proxy's token and labels the container with its hash", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = fake.created;
    const [route] = fake.routes;
    const [input] = harness.proxyInputs;
    const env = Object.values(container?.spec?.env ?? {});

    expect(input?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(route?.preamble).toBe(`PINATA ${input?.token}`);
    expect(container?.spec?.env.HTTPS_PROXY).toBe("http://pinata-proxy:3128");
    expect(env.filter((value) => value.includes(input?.token ?? "-"))).toEqual([]);
    expect(container?.summary.labels[LABELS.repoHash]).toBe(sha256Hex(harness.repoRoot));
    expect(input).not.toHaveProperty("repoHash");
    expect(input).toMatchObject({
      rules: [],
      derivedHosts: expect.any(Array),
    });
  });

  it("hands env secrets to the proxy, not to the container", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pinata:1": PINNED } });
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
            placeholder: "pinata-corp",
            secret: { env: "CORP_TOKEN" },
          },
        ],
      },
      image: { reference: "registry.example.test/pinata:1", digest: PINNED },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.proxyInputs.map((input) => input.envSecrets)).toEqual([{ corp: REAL_KEY }]);

    await expectNoLeak(fake, renderDirOf(harness), [REAL_KEY]);
  });

  it("hands the env parent proxy's credentials to the proxy input and its address without them", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pinata:1": PINNED } });
    const harness = await createHarness({
      backend: () => fake.backend,
      env: { HTTPS_PROXY: "http://corp:p%40ss@proxy.example.test:8080" },
    });

    await harness.writeJson(harness.userConfigFile, {
      image: { reference: "registry.example.test/pinata:1", digest: PINNED },
    });

    expect(await run([], harness.deps)).toBe(0);

    expect(harness.proxyInputs.map((input) => input.parentAuth)).toEqual(["corp:p@ss"]);
    expect(harness.proxyInputs.map((input) => input.parentEnv.HTTPS_PROXY)).toEqual([
      "http://proxy.example.test:8080",
    ]);

    await expectNoLeak(fake, renderDirOf(harness), ["p@ss", "p%40ss"]);
  });

  it("renders Maven proxy settings and leaves JVM options to the user on a host without ~/.m2/settings.xml", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await expect(lstat(join(harness.deps.home, ".m2", "settings.xml"))).rejects.toThrow();
    expect(await run([], harness.deps)).toBe(0);

    const [container] = fake.created;
    const env = container?.spec?.env ?? {};
    const settings = await readFile(join(renderDirOf(harness), "tools", "m2-settings.xml"), "utf8");

    expect(settings).toMatch(
      /<proxy>[\s\S]*<host>pinata-proxy<\/host>[\s\S]*<port>3128<\/port>[\s\S]*<\/proxy>/,
    );
    expect(settings).not.toContain("<password>");
    expect(env).toMatchObject({
      https_proxy: env.HTTPS_PROXY,
      PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
    });
    expect(
      Object.keys(env).filter((name) => name.startsWith("PINATA_PROXY") || name === "JAVA_TOOL_OPTIONS"),
    ).toEqual([]);

    await expectNoLeak(fake, renderDirOf(harness), [REAL_KEY]);
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

  it("derives nothing from a glab that lies in a folder a sandbox has run in", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      respond: (call) =>
        call.file.endsWith("/glab") ? { stdout: "glpat-REAL-HOST-GLAB-TOKEN-4242\n" } : undefined,
    });
    const sandboxed = join(harness.root, "sandboxed");

    await writeExecutable(join(sandboxed, "bin", "glab"));

    await writeText(
      join(harness.deps.home, ".config", "glab-cli", "config.yml"),
      ["hosts:", "    gitlab.com:", "        token: glpat-REAL-HOST-GLAB-TOKEN-4242", ""].join("\n"),
    );

    await writeRepoRecord(harness.stateDir, repoHash(sandboxed), sandboxed);

    harness.deps.env.PATH = join(sandboxed, "bin");

    expect(await run([], harness.deps)).toBe(0);

    const [input] = harness.proxyInputs;

    expect(input?.rules.filter((rule) => rule.id.startsWith("derived:glab:"))).toEqual([]);
    expect(harness.calls.filter((call) => call.file.endsWith("/glab"))).toEqual([]);
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
      target: "/opt/pinata/render",
      readOnly: true,
      kind: "bind",
    });
    expect(JSON.parse(rendered).example.key).toMatch(/^pinata-[0-9a-f]{24}$/);

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
      `pinata: blocked.example.test was blocked in the sandbox; run pinata egress allow blocked.example.test on the host\n`,
    );
    expect(harness.stderr()).toContain(
      `pinata: other.test:8443 was blocked in the sandbox; run pinata egress allow other.test:8443 on the host\n`,
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
      `pinata: ${record.host} was blocked in the sandbox; ${hint} ${harness.userConfigFile}\n`,
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
      "pinata: api.corp.test was blocked in the sandbox; it could not authenticate: credential corp is unavailable: token expired\n",
    ],
    [
      "a missing or expired host login",
      denial("llm.corp.test", 443, "login", "the corp-llm login on the host is missing or expired"),
      "pinata: llm.corp.test was blocked in the sandbox; the corp-llm login on the host is missing or expired; log in again with pi --no-sandbox and /login\n",
    ],
    [
      "egress.deny",
      denial("paste.test", 443, "egress.deny", "paste.test is in egress.deny"),
      "pinata: paste.test was blocked in the sandbox; denied by egress.deny\n",
    ],
    [
      "plain HTTP",
      denial("localhost.test", 80, "plain-http", "only HTTPS through CONNECT is proxied"),
      "pinata: localhost.test:80 was blocked in the sandbox; plain HTTP is not proxied; use https\n",
    ],
    [
      "an upstream failure",
      denial("down.test", 443, "upstream", "connect ECONNREFUSED 203.0.113.9:443"),
      "pinata: down.test was blocked in the sandbox; it could not be reached: connect ECONNREFUSED 203.0.113.9:443\n",
    ],
    [
      "a TLS name mismatch",
      denial("api.test", 443, "sni", "TLS server name evil.test does not match api.test"),
      "pinata: api.test was blocked in the sandbox; TLS server name evil.test does not match api.test\n",
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

    expect(harness.stderr()).toContain("pinata: mcp docs: not signed in; run pi mcp login docs\n");
    expect(harness.stderr()).toContain(`pinata: ${noHostPiLine(harness.hostAgentDir)}\n`);
  });

  it("names a pi argument that lies outside the folders mounted, once", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });
    const prompt = join(await realpath(await tempDir("outside-prompt")), "prompt.md");

    await writeText(prompt, "text\n");

    expect(await run(["--append-system-prompt", prompt], harness.deps)).toBe(0);

    const line = `pinata: --append-system-prompt ${prompt}: ${prompt} lies outside the folders mounted in the sandbox, so pi inside cannot read it\n`;

    expect(harness.stderr().split(line).length - 1).toBe(1);
  });
});

describe("the proxy route of the install", () => {
  it("asks the backend for the one route of the install, named by no repository", async () => {
    const fake = createFakeBackend();
    const asked: string[][] = [];
    const backend = {
      ...fake.backend,
      prepareRelay: (request: RelayRequest) => {
        asked.push(Object.keys(request).sort());

        return fake.backend.prepareRelay(request);
      },
    };
    const harness = await createHarness({ backend: () => backend });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked).toEqual([["hostPort", "imageId", "preamble"]]);
  });
});

describe("the VM's file cache watch", () => {
  const watchedLaunch = async (config: Record<string, unknown>) => {
    const events: string[] = [];
    const fake = createFakeBackend({
      vm: {
        watchFileCache: () => {
          events.push("watch");

          return {
            stop: async () => {
              events.push("stop");

              await new Promise((done) => setTimeout(done, 20));

              events.push("settled");
            },
          };
        },
      },
      exec: (spec) => {
        if (isPiSession(spec)) {
          events.push("pi");
        }

        return undefined;
      },
    });
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, config);

    expect(await run([], harness.deps)).toBe(0);

    return events;
  };

  it("runs while pi runs, stops when pi exits and is waited for before the launch returns", async () => {
    expect(await watchedLaunch({})).toEqual(["watch", "pi", "stop", "settled"]);
  });

  it("does not start when vm.releaseFileCache is off", async () => {
    expect(await watchedLaunch({ vm: { releaseFileCache: false } })).toEqual(["pi"]);
  });
});
