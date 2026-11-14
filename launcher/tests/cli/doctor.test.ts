import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type ExecIo, type ExecSpec, LABELS, type Vm } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { registerLaunch } from "../../grants/index.ts";
import type { DenialRecord } from "../../proxy/index.ts";
import { processMark, sha256Hex } from "../../shared/index.ts";
import { stdinOf } from "../support/fake-backend.ts";
import {
  createFakeBackend,
  createHarness,
  type DoctorCheck,
  doctorCheck,
  doctorReport,
  noHostPiLine,
  unreachable,
  writeManagedPi,
  writePathPi,
} from "./harness.ts";

interface Probes {
  env?: string;
  auth?: string;
  mcp?: string;
  routeExit?: number;
  mcpListExit?: number;
  ruleAnswer?: string;
  mcpAuth?: string;
  settings?: string;
  sandboxTls?: string;
}

const SANDBOX_TRUSTS = JSON.stringify({ chain: [], verdicts: [null], extraCaEnv: "/etc/pi-sandbox/ca.pem" });

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const healthServer = async (status: number) => {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });

    response.end('{"ok":true}');
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  return (server.address() as AddressInfo).port;
};

const answering =
  (probes: Probes, containerEnv: (containerId: string) => string = () => "TERM=xterm-256color\n") =>
  (spec: ExecSpec, io: ExecIo): number => {
    const write = (text: string) => {
      io.stdout.write(text);

      return 0;
    };
    const answers: Record<string, () => number> = {
      env: () => write(probes.env ?? containerEnv(spec.containerId)),
      sh: () => probes.routeExit ?? 1,
      pi: () => {
        io.stderr.write("docs: connection refused\n");

        return probes.mcpListExit ?? 0;
      },
      node: () =>
        (spec.command[2] ?? "").includes("getPeerCertificate")
          ? write(`${probes.sandboxTls ?? SANDBOX_TRUSTS}\n`)
          : write(`${probes.ruleAnswer ?? "200"}\n`),
    };

    const command = spec.command[0] === "timeout" ? spec.command.slice(2) : spec.command;

    return answers[command[0] ?? ""]?.() ?? 127;
  };

const GUEST_FILES: Array<[keyof Probes, string]> = [
  ["auth", "auth.json"],
  ["mcp", "mcp.json"],
  ["mcpAuth", "mcp-auth.json"],
  ["settings", "settings.json"],
];

const guestBackend = async (probes: Probes, vm?: Partial<Vm>) => {
  const specEnv = (containerId: string) =>
    Object.entries(fake.containers.get(containerId)?.spec?.env ?? {})
      .map(([name, value]) => `${name}=${value}\n`)
      .join("");
  const fake = createFakeBackend({
    exec: answering(probes, (containerId) => `TERM=xterm-256color\n${specEnv(containerId)}`),
    vm,
  });

  await Promise.all(
    GUEST_FILES.map(([key, name]) => {
      const text = probes[key];

      return typeof text === "string" ? fake.writeGuestFile(name, text) : undefined;
    }),
  );

  return fake;
};

const RESIZE =
  "colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false --cpu 8 --memory 10";

const hostSection = async (prepared: boolean) => [
  "host",
  `  ok    host pi           pi ${await testedPiVersion()}, managed install ~/.pi/agent/bin/pi; the image follows it`,
  "  ok    provider hosts    1 built-in providers with known hosts",
  expect.stringMatching(/^ {2}ok {4}sessions {10}~\/\.pi\/agent\/sessions\/--.+-repo-- \(host pi lists them/),
  ...(prepared ? ["  ok    host side"] : []),
];

const SHARES_UNKNOWN =
  "  skip  vm shares         colima has not written the shares of profile pi-sandbox yet";

const NO_PARENT = "  skip  parent proxy      no parent proxy configured";

const NOT_INSPECTED = "  ok    tls inspection    not inspected";

const EXAMPLE_AUTH = { example: { type: "api_key", key: "real-secret-value-1234567890" } };

const RULE = "rule derived:auth:example:key";

interface DoctorOptions {
  probes?: Probes;
  health?: number;
  userConfig?: unknown;
  hostAuth?: unknown;
  vm?: Partial<Vm>;
  hostSettings?: unknown;
  denials?: DenialRecord[];
  args?: string[];
}

const doctorWith = async (options: DoctorOptions = {}) => {
  const port = await healthServer(options.health ?? 200);
  const fake = await guestBackend(options.probes ?? {}, options.vm);
  const harness = await createHarness({
    backend: () => fake.backend,
    denials: options.denials ?? [],
    proxy: {
      ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
    },
  });

  if (options.userConfig !== undefined) {
    await harness.writeJson(harness.userConfigFile, options.userConfig);
  }

  if (options.hostAuth !== undefined) {
    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), options.hostAuth);
  }

  if (options.hostSettings !== undefined) {
    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), options.hostSettings);
  }

  const code = await run(["sandbox", "doctor", ...(options.args ?? [])], harness.deps);
  const stdout = harness.stdout();

  return { code, stdout, report: doctorReport(stdout), fake, harness, port };
};

const check = (stdout: string, name: string) => doctorCheck(stdout, name);

const blocked = (checks: DoctorCheck[]) => checks.filter((entry) => entry.name.startsWith("blocked "));

describe("pi sandbox doctor", () => {
  it("reports every check by area with a result line, in one container removed like a launch, and nothing on stderr", async () => {
    const { code, stdout, port, fake, harness } = await doctorWith();
    const container = fake.execs[0]?.spec.containerId;

    expect(stdout.split("\n")).toEqual([
      ...(await hostSection(true)),
      "",
      "sandbox",
      SHARES_UNKNOWN,
      "  ok    vm",
      "  skip  vm size           colima did not report the size of profile pi-sandbox",
      "  ok    image             pi-sandbox-base:local sha256:built-1",
      "  ok    container",
      "  ok    sync",
      "  ok    sessions share    writable at the host path",
      "",
      "network",
      `  ok    proxy             pid 77 port ${port}`,
      "  ok    proxy health      /healthz answers",
      NO_PARENT,
      NOT_INSPECTED,
      "  ok    tls in sandbox    the container trusts TLS to pi.dev through the sandbox proxy",
      "  ok    no-route          no direct route to 1.1.1.1:443",
      "  ok    mcp               pi mcp list connects to every enabled server",
      "",
      "credentials",
      "  skip  trust             no credential rule, nothing is terminated",
      "",
      "leak sweep",
      "  ok    credential sweep  no credential in the environment, auth.json or mcp.json",
      "  ok    mcp-auth sweep    no mcp-auth.json in the sandbox yet",
      "  ok    settings sweep    no settings.json package carries a credential in its URL",
      "",
      "result: ok (18 ok, 4 skipped)",
      "",
    ]);
    expect(harness.stderr()).toBe("");
    expect(code).toBe(0);
    expect(fake.execs.every((exec) => exec.spec.containerId === container && !exec.tty)).toBe(true);
    expect(fake.created.map((entry) => entry.summary.id)).toEqual([container]);
    expect(fake.containers.size).toBe(0);
  });

  it("checks trust and every credential rule host with its placeholder", async () => {
    const { stdout, fake } = await doctorWith({ probes: { ruleAnswer: "401" }, hostAuth: EXAMPLE_AUTH });
    const request = fake.execs.find(
      (exec) => exec.spec.command[0] === "node" && (exec.spec.command[2] ?? "").includes("AbortSignal"),
    );

    expect(check(stdout, "trust")).toMatchObject({
      status: "ok",
      detail: "the container trusts the proxy's certificate for models.example.test",
    });
    expect(check(stdout, RULE)).toMatchObject({
      status: "fail",
      detail: "https://models.example.test/ answered HTTP 401 with the placeholder",
    });
    expect(request?.spec.command.at(-1)).toMatch(/^Bearer pi-sandbox-[0-9a-f]{24}$/);
    expect(request?.spec.command[2]).toContain("AbortSignal.timeout(15000)");
    expect(JSON.stringify(fake.execs.map((exec) => exec.spec))).not.toContain("real-secret-value");
  });

  it("collapses the rules that pass into one line with their count, and lists each with --verbose", async () => {
    const plain = await doctorWith({ hostAuth: EXAMPLE_AUTH });
    const verbose = await doctorWith({ hostAuth: EXAMPLE_AUTH, args: ["--verbose"] });

    expect(check(plain.stdout, "rules")).toMatchObject({
      status: "ok",
      detail: "1 credential host answered through the proxy (--verbose lists them)",
    });
    expect(check(plain.stdout, RULE)).toBeUndefined();
    expect(check(verbose.stdout, RULE)).toMatchObject({
      status: "ok",
      detail: "https://models.example.test/ answered HTTP 200",
    });
    expect(check(verbose.stdout, "rules")).toBeUndefined();
    expect(plain.report.result).toBe("ok (20 ok, 3 skipped)");
    expect(verbose.report.result).toBe(plain.report.result);
  });

  it("rejects an unknown doctor option with its usage", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "doctor", "--bogus"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe(
      'pi-sandbox: unknown doctor option "--bogus"\n  hint: pi sandbox doctor [--verbose]\n',
    );
    expect(harness.stdout()).toBe("");
  });

  it("fails a rule whose host answers HTTP 502 through the proxy and gives the proxy's reason", async () => {
    const { code, stdout } = await doctorWith({
      probes: {
        ruleAnswer:
          '502 {"error":"upstream request failed: unable to get local issuer certificate; set tls.extraCa"}',
      },
      hostAuth: EXAMPLE_AUTH,
    });

    expect(check(stdout, RULE)).toMatchObject({
      status: "fail",
      detail: "https://models.example.test/ answered HTTP 502",
      reasons: ["upstream request failed: unable to get local issuer certificate; set tls.extraCa"],
    });
    expect(code).toBe(1);
  });

  it("warns, without a blocked check or notice, about a rule whose credential the proxy could not get", async () => {
    const login: DenialRecord = {
      time: 1_700_000_000_500,
      host: "models.example.test",
      port: 443,
      repoHash: "repo",
      rule: "login",
      reason: "the example login on the host is missing or expired",
      credentialRule: "derived:auth:example:key",
    };
    const { code, stdout, report, harness } = await doctorWith({
      probes: { ruleAnswer: "404" },
      hostAuth: EXAMPLE_AUTH,
      denials: [login],
    });

    expect(check(stdout, RULE)).toMatchObject({
      status: "warn",
      detail: "the example login on the host is missing or expired",
      hint: "log in again with pi --no-sandbox and /login",
    });
    expect(blocked(report.checks)).toEqual([]);
    expect(report.notices).toEqual([]);
    expect(harness.stderr()).toBe("");
    expect(code).toBe(0);
  });

  const refusal = (rule: string, reason: string, port = 443): DenialRecord => ({
    time: 1_700_000_000_500,
    host: "models.example.test",
    port,
    repoHash: "repo",
    rule,
    reason,
  });

  const doctorWithRefusals = (ruleAnswer: string, denials: DenialRecord[]) =>
    doctorWith({ probes: { ruleAnswer }, hostAuth: EXAMPLE_AUTH, denials });

  it("says why the proxy refused a rule host that resolves to a private address, once, with the config to edit", async () => {
    const reason =
      "models.example.test resolves only to restricted addresses (10.1.2.3 is a private network address)";
    const { code, stdout, report, harness } = await doctorWithRefusals("error 0", [
      refusal("private-address", reason),
    ]);

    expect(check(stdout, RULE)).toMatchObject({
      status: "fail",
      detail: "https://models.example.test/: the sandbox proxy refused it",
      reasons: [reason],
      hint: `add models.example.test to egress.privateHosts in ${harness.userConfigFile}`,
    });
    expect(stdout.split("resolves only to restricted addresses")).toHaveLength(2);
    expect(blocked(report.checks)).toEqual([]);
    expect(report.notices).toEqual([]);
    expect(code).toBe(1);
  });

  it("says egress.deny refused a rule host", async () => {
    const { stdout } = await doctorWithRefusals("error 0", [
      refusal("egress.deny", "models.example.test is in egress.deny"),
    ]);

    expect(check(stdout, RULE)).toMatchObject({
      detail: "https://models.example.test/: the sandbox proxy refused it",
      reasons: ["denied by egress.deny"],
    });
    expect(check(stdout, RULE)?.hint).toBeUndefined();
  });

  it("keeps the fetch error when the only refusal is for another port, and warns about that port as blocked", async () => {
    const { stdout, harness } = await doctorWithRefusals("error 0", [
      refusal("private-address", "models.example.test resolves only to restricted addresses", 8443),
    ]);

    expect(check(stdout, RULE)).toMatchObject({ status: "fail", detail: "https://models.example.test/: 0" });
    expect(check(stdout, "blocked models.example.test:8443")).toMatchObject({
      status: "warn",
      detail: "models.example.test resolves only to restricted addresses",
      hint: `add models.example.test to egress.privateHosts in ${harness.userConfigFile}`,
    });
    expect(harness.stderr()).toBe("");
  });

  it("keeps the fetch error of a certificate not yet valid and says the VM clock is behind, with the restart", async () => {
    const { stdout } = await doctorWithRefusals("error CERT_NOT_YET_VALID", []);
    const clock = {
      reasons: [
        "the sandbox VM's clock is behind the host's, so the proxy's certificate, dated by the host, is not valid there yet",
      ],
      hint: "restart the VM to reset its clock: run pi sandbox stop once no pi session runs, then pi sandbox doctor again",
    };

    expect(check(stdout, RULE)).toMatchObject({
      status: "fail",
      detail: "https://models.example.test/: CERT_NOT_YET_VALID",
      ...clock,
    });
    expect(check(stdout, "trust")).toMatchObject({
      detail: "models.example.test: CERT_NOT_YET_VALID",
      ...clock,
    });
  });

  it("fails the trust check on a certificate error, without the clock hint, and the mcp check inside", async () => {
    const { code, stdout } = await doctorWith({
      probes: { ruleAnswer: "error SELF_SIGNED_CERT_IN_CHAIN", mcpListExit: 1 },
      hostAuth: EXAMPLE_AUTH,
    });

    expect(check(stdout, "trust")).toMatchObject({
      status: "fail",
      detail: "models.example.test: SELF_SIGNED_CERT_IN_CHAIN",
      reasons: [],
    });
    expect(check(stdout, "trust")?.hint).toBeUndefined();
    expect(check(stdout, "mcp")).toMatchObject({
      status: "fail",
      detail: "pi mcp list exited 1: docs: connection refused",
    });
    expect(code).toBe(1);
  });

  it("probes the session dir the running container was started with, not the planned one", async () => {
    const fake = await guestBackend({});
    const find = fake.backend.findContainers;

    fake.backend.findContainers = async (labels) =>
      (await find(labels)).map((summary) =>
        fake.execs.length === 0
          ? summary
          : { ...summary, labels: { ...summary.labels, [LABELS.sessionDir]: "sessions.host is off" } },
      );

    const port = await healthServer(200);
    const harness = await createHarness({
      backend: () => fake.backend,
      proxy: {
        ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
      },
    });

    await run(["sandbox", "doctor"], harness.deps);

    expect(check(harness.stdout(), "sessions share")).toMatchObject({
      status: "skip",
      detail: "in the sandbox volume (sessions.host is off)",
    });
  });

  it("handshakes with pi.dev from inside through the sandbox proxy with node and the container's trust", async () => {
    const { fake } = await doctorWith();
    const probe = fake.execs.find((exec) => (exec.spec.command[2] ?? "").includes("getPeerCertificate"));

    const input = probe === undefined ? "{}" : stdinOf(probe).toString();

    expect(probe?.spec.command.slice(0, 2)).toEqual(["node", "-e"]);
    expect(JSON.parse(input)).toEqual({
      host: "pi.dev",
      port: 443,
      proxy: "env",
      trusts: ["default"],
    });
  });

  it("fails the sandbox layer when the host trusts pi.dev and the container does not", async () => {
    const { code, stdout } = await doctorWith({
      probes: {
        sandboxTls: JSON.stringify({
          chain: [],
          verdicts: ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY"],
          extraCaEnv: "/etc/pi-sandbox/ca.pem",
        }),
      },
    });

    expect(check(stdout, "tls inspection")?.status).toBe("ok");
    expect(check(stdout, "tls in sandbox")).toMatchObject({
      status: "fail",
      detail: "the host trusts TLS to pi.dev, the container does not: UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      reasons: [
        "the container's trust (NODE_EXTRA_CA_CERTS=/etc/pi-sandbox/ca.pem) does not hold the public roots",
      ],
    });
    expect(code).toBe(1);
  });

  it("reports a sandbox proxy that does not tunnel to pi.dev as a network failure", async () => {
    const { stdout } = await doctorWith({ probes: { sandboxTls: '{"failure":"the proxy answered 403"}' } });

    expect(check(stdout, "tls in sandbox")).toMatchObject({
      status: "fail",
      detail: "pi.dev:443 through the sandbox proxy: the proxy answered 403",
    });
  });

  it("runs pi mcp list under a 30 s timeout and fails when it runs out", async () => {
    const { code, stdout, fake } = await doctorWith({ probes: { mcpListExit: 124 } });

    expect(fake.execs.map((exec) => exec.spec.command)).toContainEqual([
      "timeout",
      "30",
      "pi",
      "mcp",
      "list",
    ]);
    expect(check(stdout, "mcp")).toMatchObject({
      status: "fail",
      detail: "pi mcp list did not finish in 30 s",
    });
    expect(code).toBe(1);
  });

  it("runs the probes at once", async () => {
    const mcpAsked: Array<() => void> = [];
    const mcpStarted = new Promise<void>((resolve) => {
      mcpAsked.push(resolve);
    });
    const plain = answering({});
    const fake = createFakeBackend({
      exec: async (spec, io) => {
        if (spec.command[0] === "timeout") {
          mcpAsked.forEach((resolve) => {
            resolve();
          });
        }

        if (spec.command[0] === "sh") {
          await Promise.race([mcpStarted, new Promise((resolve) => setTimeout(resolve, 2000))]);
        }

        return plain(spec, io);
      },
    });
    const port = await healthServer(200);
    const harness = await createHarness({
      backend: () => fake.backend,
      proxy: {
        ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
      },
    });
    const startedAt = Date.now();

    await run(["sandbox", "doctor"], harness.deps);

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(check(harness.stdout(), "no-route")?.status).toBe("ok");
  });

  it("fails the sweep on an mcp.json header or stdio env value that is not a placeholder", async () => {
    const { stdout } = await doctorWith({
      probes: {
        mcp: JSON.stringify({
          mcpServers: {
            docs: {
              url: "https://docs.example.test/mcp",
              headers: { Authorization: "Bearer real-secret-1234567890" },
            },
            tool: {
              command: "tool",
              env: { TOOL_TOKEN: "pi-sandbox-0123456789abcdef01234567", MODE: "fast" },
            },
          },
        }),
      },
    });

    expect(check(stdout, "credential sweep")).toMatchObject({
      status: "fail",
      detail: "1 finding in the environment, auth.json or mcp.json",
      reasons: [
        "/home/pi/.pi/agent/mcp.json holds a value other than a placeholder at mcpServers.docs.headers.Authorization",
      ],
    });
    expect(stdout).not.toContain("real-secret");
  });

  it("passes the sweep over the container's own environment, whose proxy token is no placeholder", async () => {
    const { stdout, fake } = await doctorWith();
    const env = fake.created[0]?.spec?.env ?? {};

    expect(env.PI_SANDBOX_PROXY_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(check(stdout, "credential sweep")).toMatchObject({
      status: "ok",
      detail: "no credential in the environment, auth.json or mcp.json",
    });
  });

  it("fails the sweep on secret-named variables and auth.json values other than the placeholder", async () => {
    const { code, stdout } = await doctorWith({
      probes: {
        env: "TERM=xterm\nGATEWAY_API_KEY=real-secret-value-1234567890\nSESSION_TOKEN=\nPLAIN=real-secret-value-1234567890\n",
        auth: JSON.stringify({ llm: { type: "api_key", key: "real-secret-value-1234567890" } }),
      },
    });

    expect(check(stdout, "credential sweep")).toMatchObject({
      status: "fail",
      detail: "2 findings in the environment, auth.json or mcp.json",
      reasons: [
        "environment variable GATEWAY_API_KEY holds a value other than the placeholder",
        "/home/pi/.pi/agent/auth.json holds a value other than the placeholder at llm.key",
      ],
    });
    expect(stdout).not.toContain("real-secret-value-1234567890");
    expect(code).toBe(1);
  });

  it("passes the sweep when secret-named variables and auth.json hold only the placeholder", async () => {
    const { stdout } = await doctorWith({
      probes: {
        env: "TERM=xterm\nGATEWAY_API_KEY=pi-sandbox-0123456789abcdef01234567\nSESSION_TOKEN=\n",
        auth: JSON.stringify({ llm: { type: "api_key", key: "pi-sandbox-0123456789abcdef01234567" } }),
      },
    });

    expect(check(stdout, "credential sweep")).toMatchObject({
      status: "ok",
      detail: "no credential in the environment, auth.json or mcp.json",
    });
  });

  it("removes only its own container when another launch of the repository is live", async () => {
    const port = await healthServer(200);
    const fake = createFakeBackend({ exec: answering({}) });
    const harness = await createHarness({
      backend: () => fake.backend,
      proxy: {
        ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
      },
    });

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "00000000000000cc",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    const other = fake.addContainer({
      name: "other-launch",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.repoHash]: sha256Hex(harness.repoRoot),
        [LABELS.launchId]: "00000000000000cc",
      },
      state: "running",
      image: "x",
    });

    await run(["sandbox", "doctor"], harness.deps);

    expect([...fake.containers.keys()]).toEqual([other]);
  });

  it("strips a credential from a host settings package URL before the sync, says so in the notices, and the settings sweep passes", async () => {
    const { stdout, report, harness } = await doctorWith({
      hostSettings: {
        packages: ["npm:fine", { source: "git:https://user:hunter2@git.example.test/team/ext.git" }],
      },
    });

    expect(check(stdout, "settings sweep")).toMatchObject({
      status: "ok",
      detail: "no settings.json package carries a credential in its URL",
    });
    expect(report.notices).toEqual([
      "settings.json package git.example.test carried a credential in its URL; it was removed inside the sandbox",
    ]);
    expect(harness.stderr()).toBe("");
    expect(`${harness.stdout()}${harness.stderr()}`).not.toContain("hunter2");
  });

  it("fails the mcp-auth sweep on a token that is not a placeholder", async () => {
    const { code, stdout } = await doctorWith({
      probes: {
        mcpAuth: JSON.stringify({
          "mcp__docs|https://docs.example.test/mcp": {
            tokens: { access_token: "real-access-token-0123456789", token_type: "Bearer" },
          },
        }),
      },
    });

    expect(check(stdout, "mcp-auth sweep")).toMatchObject({
      status: "fail",
      detail:
        "mcp-auth.json holds a token that is not a placeholder (mcp__docs|https://docs.example.test/mcp)",
    });
    expect(stdout).not.toContain("real-access-token");
    expect(code).toBe(1);
  });

  it("fails when the container reaches the internet directly", async () => {
    const { code, stdout } = await doctorWith({ probes: { routeExit: 0 } });

    expect(check(stdout, "no-route")).toMatchObject({
      status: "fail",
      detail: "1.1.1.1:443 is reachable directly",
    });
    expect(code).toBe(1);
  });

  it("fails the proxy check when /healthz does not answer", async () => {
    const { code, stdout } = await doctorWith({ health: 503 });

    expect(check(stdout, "proxy health")).toMatchObject({
      status: "fail",
      detail: "/healthz does not answer",
    });
    expect(code).toBe(1);
  });

  it("stops at the vm stage with the engine's hint when the VM engine is unreachable, still checks the host and exits 1", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(1);
    expect(harness.stdout().split("\n")).toEqual([
      ...(await hostSection(false)),
      "",
      "sandbox",
      SHARES_UNKNOWN,
      "  fail  vm                the sandbox VM engine is unreachable at ~/.colima/pi-sandbox/docker.sock: socket missing",
      "        hint: run launcher/install.sh or colima start --profile pi-sandbox --activate=false",
      "  skip  probes            not run: the vm stage failed",
      "",
      "network",
      NO_PARENT,
      NOT_INSPECTED,
      "",
      "result: fail (1 failed, 4 ok, 3 skipped)",
      "",
    ]);
    expect(harness.stderr()).toBe("");
  });

  it("runs no shares stage, so it never restarts the VM to share a path", async () => {
    const shared: string[][] = [];
    const { stdout } = await doctorWith({
      vm: {
        ensureShares: async (paths) => {
          shared.push(paths.map((entry) => entry.path));
        },
      },
    });

    expect([check(stdout, "vm")?.status, check(stdout, "host side")?.status]).toEqual(["ok", "ok"]);
    expect(check(stdout, "shares")).toBeUndefined();
    expect(shared).toEqual([]);
  });

  it("skips the sandbox and names the paths to share when the VM lacks one, starting nothing", async () => {
    const started: string[] = [];
    const { code, stdout, fake } = await doctorWith({
      vm: {
        coverage: async () => ({ shares: [], missing: ["/Volumes/work"] }),
        ensureRunning: async () => {
          started.push("vm");
        },
      },
    });

    expect(check(stdout, "vm shares")).toMatchObject({
      status: "warn",
      detail: "the sandbox VM does not share /Volumes/work",
      hint: "run pi once here while no other pi session runs, which shares it and restarts the VM, then pi sandbox doctor again",
    });
    expect(check(stdout, "sandbox")).toMatchObject({
      status: "skip",
      detail: "not started until the VM shares /Volumes/work",
    });
    expect(["vm", "probes", "host side"].map((name) => check(stdout, name))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(started).toEqual([]);
    expect(fake.created).toEqual([]);
    expect(code).toBe(0);
  });

  it("reports the proxy and image stages both, then stops after a failed image and says the probes did not run", async () => {
    const fake = createFakeBackend({ exec: answering({}) });
    const failing = { ...fake.backend, buildImage: async () => Promise.reject(new Error("build failed")) };
    const harness = await createHarness({ backend: () => failing });

    await harness.writeJson(harness.userConfigFile, { egress: { allow: [] } });

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(1);
    expect(harness.stdout().split("\n")).toEqual([
      ...(await hostSection(true)),
      "",
      "sandbox",
      SHARES_UNKNOWN,
      "  ok    vm",
      "  fail  image             build failed",
      "  skip  probes            not run: the image stage failed",
      "",
      "network",
      "  ok    proxy             pid 4242 port 3128",
      NO_PARENT,
      NOT_INSPECTED,
      "",
      "result: fail (1 failed, 7 ok, 3 skipped)",
      "",
    ]);
  });

  it("prints the report so far and the notices before an unexpected error, without a result line", async () => {
    const fake = await guestBackend({});
    const detect = fake.backend.detect;
    const port = await healthServer(200);
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        detect: async () => {
          if (fake.execs.length > 0) {
            throw new Error("engine gone");
          }

          return detect();
        },
      }),
      proxy: {
        ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
      },
    });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      packages: [{ source: "git:https://user:hunter2@git.example.test/team/ext.git" }],
    });

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(70);

    const report = doctorReport(harness.stdout());

    expect([check(harness.stdout(), "container")?.status, check(harness.stdout(), "sync")?.status]).toEqual([
      "ok",
      "ok",
    ]);
    expect(report.notices).toEqual([
      "settings.json package git.example.test carried a credential in its URL; it was removed inside the sandbox",
    ]);
    expect(report.result).toBeUndefined();
    expect(harness.stderr()).toBe("pi-sandbox: unexpected error: engine gone\n");
  });

  describe("on a terminal", () => {
    const terminalDoctor = async (env: Record<string, string> = {}) => {
      const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend), env });

      (harness.deps.stdout as { isTTY?: boolean }).isTTY = true;
      (harness.deps.stderr as { isTTY?: boolean }).isTTY = true;

      const code = await run(["sandbox", "doctor"], harness.deps);

      return { code, harness };
    };

    it("colours the words but keeps the plain layout, and clears its progress line before the report", async () => {
      const { code, harness } = await terminalDoctor();
      const stdout = harness.stdout();

      expect(stdout).toContain("\u001b[1;31mfail\u001b[0m  vm ");
      expect(stdout).toContain("\u001b[32mok\u001b[0m    host pi ");
      expect(stdout).toContain("\u001b[36mhint:\u001b[0m run launcher/install.sh");
      expect(stdout).toContain("result: \u001b[1;31mfail\u001b[0m (");
      expect(doctorReport(stripVTControlCharacters(stdout)).result).toBe("fail (1 failed, 4 ok, 3 skipped)");
      expect(harness.stderr().startsWith("\r\u001b[2Kpi sandbox doctor: preparing the sandbox")).toBe(true);
      expect(harness.stderr().endsWith("\r\u001b[2K")).toBe(true);
      expect(harness.stderr()).not.toContain("\n");
      expect(code).toBe(1);
    });

    it("prints no colour with NO_COLOR or a dumb TERM, and no progress line on a dumb TERM", async () => {
      const envs: Array<Record<string, string>> = [{ NO_COLOR: "1" }, { TERM: "dumb" }];
      const runs = await Promise.all(envs.map(async (env) => (await terminalDoctor(env)).harness));
      const outputs = runs.map((harness) => harness.stdout());

      expect(outputs.map((stdout) => doctorReport(stdout).result)).toEqual([
        "fail (1 failed, 4 ok, 3 skipped)",
        "fail (1 failed, 4 ok, 3 skipped)",
      ]);
      expect(outputs.filter((stdout) => stdout.includes("\u001b["))).toEqual([]);
      expect(runs[1]?.stderr()).toBe("");
    });
  });

  describe("vm size", () => {
    const sizeCheck = async (size: Vm["size"], machine?: { cpus: number; memoryGiB: number }) => {
      const fake = createFakeBackend({ exec: answering({}), vm: { size } });
      const port = await healthServer(200);
      const harness = await createHarness({
        backend: () => fake.backend,
        machine,
        proxy: {
          ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
        },
      });

      const code = await run(["sandbox", "doctor"], harness.deps);

      return { code, found: check(harness.stdout(), "vm size") };
    };

    it("warns with the resize command for a 2 CPU, 4 GiB profile without failing doctor", async () => {
      const { code, found } = await sizeCheck(async () => ({ cpus: 2, memoryGiB: 4 }));

      expect(found).toMatchObject({
        status: "warn",
        detail: "profile pi-sandbox has 2 CPUs and 4 GiB, below 8 CPUs and 10 GiB",
        hint: `resize it with ${RESIZE}`,
      });
      expect(code).toBe(0);
    });

    it("measures the profile against the size install.sh gives this machine", async () => {
      const { found } = await sizeCheck(async () => ({ cpus: 4, memoryGiB: 4 }), { cpus: 4, memoryGiB: 8 });

      expect(found).toMatchObject({ status: "ok", detail: "profile pi-sandbox has 4 CPUs and 4 GiB" });
    });
  });
});

describe("pi sandbox doctor on the host pi", () => {
  const hostPiCheck = async (
    prepare: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>,
    hostPi = true,
  ) => {
    const down = unreachable(createFakeBackend().backend);
    const harness = await createHarness({
      backend: () => down,
      ...(hostPi ? {} : { hostPi: false as const }),
    });

    await prepare(harness);

    await run(["sandbox", "doctor"], harness.deps);

    return { harness, found: check(harness.stdout(), "host pi") };
  };

  it("names pi's managed install, with the home shown as ~, and says the image follows it", async () => {
    const { found } = await hostPiCheck(async (harness) => {
      await writeManagedPi(harness.hostAgentDir, "1.6.0");
    });

    expect(found).toMatchObject({
      status: "ok",
      detail: "pi 1.6.0, managed install ~/.pi/agent/bin/pi; the image follows it",
    });
  });

  it("warns when the managed pi is older than the pi the launcher is tested with", async () => {
    const { found } = await hostPiCheck(async (harness) => {
      await writeManagedPi(harness.hostAgentDir, "1.0.0");
    });

    expect(found).toMatchObject({
      status: "warn",
      detail: `pi 1.0.0 (managed install ~/.pi/agent/bin/pi) is older than ${await testedPiVersion()}, the pi this launcher is tested with`,
      hint: "run pi update",
    });
  });

  it("fails without a managed pi, even with a pi on PATH, with the parts of the missing-pi line", async () => {
    const { harness, found } = await hostPiCheck(async (harness) => {
      harness.deps.env.PATH = (await writePathPi(join(harness.root, "brew"), "1.7.0")).bin;
    }, false);
    const [ignored, effect] = found?.reasons ?? [];
    const joined = `${found?.detail} (${ignored}): ${effect}; ${found?.hint}`;

    expect(found).toMatchObject({ status: "fail", detail: "no managed pi in ~/.pi/agent" });
    expect(found?.reasons).toHaveLength(2);
    expect(joined.replace("~/", `${harness.deps.home}/`)).toBe(noHostPiLine(harness.hostAgentDir));
    expect(check(harness.stdout(), "provider hosts")).toMatchObject({ status: "skip", detail: "no host pi" });
  });

  it("says the missing pi once, in its check, not again in the notices of a run that prepares the sandbox", async () => {
    const { stdout, report } = await (async () => {
      const port = await healthServer(200);
      const fake = await guestBackend({});
      const harness = await createHarness({
        backend: () => fake.backend,
        hostPi: false,
        proxy: {
          ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
        },
      });

      await run(["sandbox", "doctor"], harness.deps);

      return { stdout: harness.stdout(), report: doctorReport(harness.stdout()) };
    })();

    expect(check(stdout, "host side")?.status).toBe("ok");
    expect(stdout.split("no managed pi in")).toHaveLength(2);
    expect(report.notices.filter((notice) => notice.includes("no managed pi"))).toEqual([]);
  });
});

describe("pi sandbox doctor parent proxy", () => {
  const parentLine = async (url: (port: number) => string) => {
    const listener = createServer();

    await new Promise<void>((resolve) => listener.listen(0, "::1", resolve));

    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));

    const port = (listener.address() as AddressInfo).port;
    const down = unreachable(createFakeBackend().backend);
    const harness = await createHarness({ backend: () => down });

    harness.deps.env.HTTPS_PROXY = url(port);

    await run(["sandbox", "doctor"], harness.deps);

    return { port, found: check(harness.stdout(), "parent proxy") };
  };

  it("connects to an IPv6 http parent proxy without its brackets", async () => {
    const { port, found } = await parentLine((listening) => `http://[::1]:${listening}`);

    expect(found).toMatchObject({
      section: "network",
      status: "ok",
      detail: `[::1]:${port} accepts connections`,
    });
  });

  it("fails an https parent proxy, which the launcher proxy does not chain to", async () => {
    expect((await parentLine(() => "https://proxy.example.test")).found).toMatchObject({
      section: "network",
      status: "fail",
      detail: "HTTPS_PROXY uses https, only http parent proxies are supported",
    });
  });
});

describe("pi sandbox doctor mcp sign-in checks", () => {
  it("reports one check per OAuth server from the host pi sign-in store, with the login command as the hint", async () => {
    const down = unreachable(createFakeBackend().backend);
    const harness = await createHarness({ backend: () => down });
    const now = harness.deps.now();

    await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
      mcpServers: {
        docs: { url: "https://docs.example.test/mcp" },
        signed: { url: "https://signed.example.test/mcp" },
        keyed: { url: "https://keyed.example.test/mcp", headers: { Authorization: "Bearer x" } },
      },
    });

    await harness.writeJson(join(harness.hostAgentDir, "mcp-auth.json"), {
      "mcp__signed|https://signed.example.test/mcp": {
        tokens: { access_token: "real-access-token" },
        tokensExpireAt: now + 2 * 3_600_000,
      },
    });

    await run(["sandbox", "doctor"], harness.deps);

    const servers = doctorReport(harness.stdout()).checks.filter(
      (entry) => entry.section === "credentials" && entry.name.startsWith("mcp "),
    );

    expect(servers).toMatchObject([
      { status: "warn", name: "mcp docs", detail: "needs sign-in", hint: "run pi mcp login docs" },
      { status: "ok", name: "mcp signed", detail: "signed in on the host (expires in 2 h)" },
    ]);
    expect(servers[1]?.hint).toBeUndefined();
    expect(harness.stdout()).not.toContain("real-access-token");
  });
});
