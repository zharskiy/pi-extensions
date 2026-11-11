import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ExecIo, type ExecSpec, LABELS, type Vm } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { registerLaunch } from "../../grants/index.ts";
import type { DenialRecord } from "../../proxy/index.ts";
import { processMark, sha256Hex } from "../../shared/index.ts";
import {
  createFakeBackend,
  createHarness,
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
}

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
      node: () => write(`${probes.ruleAnswer ?? "200"}\n`),
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

const HOST_CHECK_LINES = [
  "skip vm shares: colima has not written the shares of profile pi-sandbox yet",
  expect.stringMatching(
    /^ok host pi: pi \S+, managed install \/.+\/home\/\.pi\/agent\/bin\/pi; the image follows it$/,
  ),
  "ok provider hosts: 1 built-in providers with known hosts",
  "skip parent proxy: no parent proxy configured",
  expect.stringMatching(/^ok sessions: \/.+\/home\/\.pi\/agent\/sessions\/--.+-repo-- \(host pi lists them/),
];

const PREPARED = ["ok vm", "ok host"];

const VM_LINES = ["skip vm size: colima did not report the size of profile pi-sandbox"];

const doctorWith = async (
  probes: Probes,
  healthStatus = 200,
  userConfig?: unknown,
  hostAuth?: unknown,
  vm?: Partial<Vm>,
  hostSettings?: unknown,
  denials: DenialRecord[] = [],
) => {
  const port = await healthServer(healthStatus);
  const fake = await guestBackend(probes, vm);
  const harness = await createHarness({
    backend: () => fake.backend,
    denials,
    proxy: {
      ensure: async () => ({ proxy: { pid: 77, port, boot: 0, start: "", inputHash: "h" }, notices: [] }),
    },
  });

  if (userConfig !== undefined) {
    await harness.writeJson(harness.userConfigFile, userConfig);
  }

  if (hostAuth !== undefined) {
    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), hostAuth);
  }

  if (hostSettings !== undefined) {
    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), hostSettings);
  }

  const code = await run(["sandbox", "doctor"], harness.deps);
  const lines = harness.stdout().trim().split("\n");

  return { code, lines, fake, harness, port };
};

describe("pi sandbox doctor", () => {
  it("prints one ok line per stage and per check when every probe passes, in one container removed like a launch", async () => {
    const { code, lines, port, fake } = await doctorWith({});
    const container = fake.execs[0]?.spec.containerId;

    expect(lines).toEqual([
      ...PREPARED,
      `ok proxy: pid 77 port ${port}`,
      "ok image: pi-sandbox-base:local sha256:built-1",
      "ok container",
      "ok sync",
      "ok proxy health: /healthz answers",
      "ok credential sweep: no credential in the environment, auth.json or mcp.json",
      "ok no-route: no direct route to 1.1.1.1:443",
      "ok mcp: pi mcp list connects to every enabled server",
      "ok mcp-auth sweep: no mcp-auth.json in the sandbox yet",
      "ok settings sweep: no settings.json package carries a credential in its URL",
      "ok sessions share: writable at the host path",
      "skip trust: no credential rule, nothing is terminated",
      ...VM_LINES,
      ...HOST_CHECK_LINES,
    ]);
    expect(code).toBe(0);
    expect(fake.execs.every((exec) => exec.spec.containerId === container && !exec.tty)).toBe(true);
    expect(fake.created.map((entry) => entry.summary.id)).toEqual([container]);
    expect(fake.containers.size).toBe(0);
  });

  it("checks trust and every credential rule host with its placeholder", async () => {
    const { lines, fake } = await doctorWith({ ruleAnswer: "401" }, 200, undefined, {
      example: { type: "api_key", key: "real-secret-value-1234567890" },
    });
    const request = fake.execs.find((exec) => exec.spec.command[0] === "node");

    expect(lines).toContain("ok trust: the container trusts the proxy's certificate for models.example.test");
    expect(lines).toContain(
      "fail rule derived:auth:example:key: https://models.example.test/ answered HTTP 401 with the placeholder",
    );
    expect(request?.spec.command.at(-1)).toMatch(/^Bearer pi-sandbox-[0-9a-f]{24}$/);
    expect(request?.spec.command[2]).toContain("AbortSignal.timeout(15000)");
    expect(JSON.stringify(fake.execs.map((exec) => exec.spec))).not.toContain("real-secret-value");
  });

  it("fails a rule whose host answers HTTP 502 through the proxy and prints the proxy's reason", async () => {
    const { code, lines } = await doctorWith(
      {
        ruleAnswer:
          '502 {"error":"upstream request failed: unable to get local issuer certificate; set tls.extraCa"}',
      },
      200,
      undefined,
      { example: { type: "api_key", key: "real-secret-value-1234567890" } },
    );

    expect(lines).toContain(
      "fail rule derived:auth:example:key: https://models.example.test/ answered HTTP 502: upstream request failed: unable to get local issuer certificate; set tls.extraCa",
    );
    expect(code).toBe(1);
  });

  it("warns, without a stray notice, about a rule whose credential the proxy could not get", async () => {
    const login: DenialRecord = {
      time: 1_700_000_000_500,
      host: "models.example.test",
      port: 443,
      repoHash: "repo",
      rule: "login",
      reason: "the example login on the host is missing or expired",
      credentialRule: "derived:auth:example:key",
    };
    const { code, lines, harness } = await doctorWith(
      { ruleAnswer: "404" },
      200,
      undefined,
      { example: { type: "api_key", key: "real-secret-value-1234567890" } },
      undefined,
      undefined,
      [login],
    );

    expect(lines).toContain(
      "warn rule derived:auth:example:key: the example login on the host is missing or expired; log in again with pi --no-sandbox and /login",
    );
    expect(harness.stderr()).not.toContain("was blocked");
    expect(code).toBe(0);
  });

  it("fails the trust check on a certificate error and the mcp check inside", async () => {
    const { code, lines } = await doctorWith(
      { ruleAnswer: "error SELF_SIGNED_CERT_IN_CHAIN", mcpListExit: 1 },
      200,
      undefined,
      { example: { type: "api_key", key: "real-secret-value-1234567890" } },
    );

    expect(lines).toContain("fail trust: models.example.test: SELF_SIGNED_CERT_IN_CHAIN");
    expect(lines).toContain("fail mcp: pi mcp list exited 1: docs: connection refused");
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

    expect(harness.stdout()).toContain("skip sessions share: in the sandbox volume (sessions.host is off)\n");
  });

  it("runs pi mcp list under a 30 s timeout and fails when it runs out", async () => {
    const { code, lines, fake } = await doctorWith({ mcpListExit: 124 });

    expect(fake.execs.map((exec) => exec.spec.command)).toContainEqual([
      "timeout",
      "30",
      "pi",
      "mcp",
      "list",
    ]);
    expect(lines).toContain("fail mcp: pi mcp list did not finish in 30 s");
    expect(code).toBe(1);
  });

  it("runs the probes at once and still prints them in table order", async () => {
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

    const lines = harness.stdout().trim().split("\n");
    const names = lines.map((line) => line.split(":")[0]);

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(names.indexOf("ok no-route")).toBeLessThan(names.indexOf("ok mcp"));
  });

  it("fails the sweep on an mcp.json header or stdio env value that is not a placeholder", async () => {
    const { lines } = await doctorWith({
      mcp: JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://docs.example.test/mcp",
            headers: { Authorization: "Bearer real-secret-1234567890" },
          },
          tool: { command: "tool", env: { TOOL_TOKEN: "pi-sandbox-0123456789abcdef01234567", MODE: "fast" } },
        },
      }),
    });
    const sweep = lines.find((line) => line.startsWith("fail credential sweep")) ?? "";

    expect(sweep).toBe(
      "fail credential sweep: /home/pi/.pi/agent/mcp.json holds a value other than a placeholder at mcpServers.docs.headers.Authorization",
    );
    expect(lines.join("\n")).not.toContain("real-secret");
  });

  it("passes the sweep over the container's own environment, whose proxy token is no placeholder", async () => {
    const { lines, fake } = await doctorWith({});
    const env = fake.created[0]?.spec?.env ?? {};

    expect(env.PI_SANDBOX_PROXY_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(lines).toContain("ok credential sweep: no credential in the environment, auth.json or mcp.json");
  });

  it("fails the sweep on secret-named variables and auth.json values other than the placeholder", async () => {
    const { code, lines } = await doctorWith({
      env: "TERM=xterm\nGATEWAY_API_KEY=real-secret-value-1234567890\nSESSION_TOKEN=\nPLAIN=real-secret-value-1234567890\n",
      auth: JSON.stringify({ llm: { type: "api_key", key: "real-secret-value-1234567890" } }),
    });
    const sweep = lines.find((line) => line.startsWith("fail credential sweep")) ?? "";

    expect(sweep).toBe(
      [
        "fail credential sweep: environment variable GATEWAY_API_KEY holds a value other than the placeholder",
        "/home/pi/.pi/agent/auth.json holds a value other than the placeholder at llm.key",
      ].join("; "),
    );
    expect(lines.join("\n")).not.toContain("real-secret-value-1234567890");
    expect(code).toBe(1);
  });

  it("passes the sweep when secret-named variables and auth.json hold only the placeholder", async () => {
    const { lines } = await doctorWith(
      {
        env: "TERM=xterm\nGATEWAY_API_KEY=pi-sandbox-0123456789abcdef01234567\nSESSION_TOKEN=\n",
        auth: JSON.stringify({ llm: { type: "api_key", key: "pi-sandbox-0123456789abcdef01234567" } }),
      },
      200,
    );

    expect(lines).toContain("ok credential sweep: no credential in the environment, auth.json or mcp.json");
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

  it("strips a credential from a host settings package URL before the sync, so the settings sweep passes", async () => {
    const { lines, harness } = await doctorWith({}, 200, undefined, undefined, undefined, {
      packages: ["npm:fine", { source: "git:https://user:hunter2@git.example.test/team/ext.git" }],
    });

    expect(lines).toContain("ok settings sweep: no settings.json package carries a credential in its URL");
    expect(harness.stderr()).toContain(
      "settings.json package git.example.test carried a credential in its URL; it was removed inside the sandbox",
    );
    expect(`${harness.stdout()}${harness.stderr()}`).not.toContain("hunter2");
  });

  it("fails the mcp-auth sweep on a token that is not a placeholder", async () => {
    const { code, lines } = await doctorWith({
      mcpAuth: JSON.stringify({
        "mcp__docs|https://docs.example.test/mcp": {
          tokens: { access_token: "real-access-token-0123456789", token_type: "Bearer" },
        },
      }),
    });

    expect(lines).toContain(
      "fail mcp-auth sweep: mcp-auth.json holds a token that is not a placeholder (mcp__docs|https://docs.example.test/mcp)",
    );
    expect(lines.join("\n")).not.toContain("real-access-token");
    expect(code).toBe(1);
  });

  it("fails when the container reaches the internet directly", async () => {
    const { code, lines } = await doctorWith({ routeExit: 0 });

    expect(lines).toContain("fail no-route: 1.1.1.1:443 is reachable directly");
    expect(code).toBe(1);
  });

  it("fails the proxy check when /healthz does not answer", async () => {
    const { code, lines } = await doctorWith({}, 503);

    expect(lines).toContain("fail proxy health: /healthz does not answer");
    expect(code).toBe(1);
  });

  it("stops at the vm stage when the VM engine is unreachable, prints the host checks and exits 1", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(1);

    const lines = harness.stdout().trim().split("\n");

    expect(lines[0]).toMatch(
      /^fail vm: the sandbox VM engine is unreachable at ~\/\.colima\/pi-sandbox\/docker\.sock/,
    );
    expect(lines.slice(1)).toEqual(HOST_CHECK_LINES);
  });

  it("runs no shares stage, so it never restarts the VM to share a path", async () => {
    const shared: string[][] = [];
    const { lines } = await doctorWith({}, 200, undefined, undefined, {
      ensureShares: async (paths) => {
        shared.push(paths.map((entry) => entry.path));
      },
    });

    expect(lines.slice(0, 2)).toEqual(["ok vm", "ok host"]);
    expect(shared).toEqual([]);
  });

  it("skips the sandbox and names the paths to share when the VM lacks one, starting nothing", async () => {
    const started: string[] = [];
    const { code, lines, fake } = await doctorWith({}, 200, undefined, undefined, {
      coverage: async () => ({ shares: [], missing: ["/Volumes/work"] }),
      ensureRunning: async () => {
        started.push("vm");
      },
    });

    expect(lines[0]).toBe(
      "skip sandbox: run pi once here to share /Volumes/work, then pi sandbox doctor again",
    );
    expect(lines[1]).toMatch(/^warn vm shares: the sandbox VM does not share \/Volumes\/work; /);
    expect(started).toEqual([]);
    expect(fake.created).toEqual([]);
    expect(code).toBe(0);
  });

  it("reports the proxy and image stages both, then stops after a failed image", async () => {
    const fake = createFakeBackend({ exec: answering({}) });
    const failing = { ...fake.backend, buildImage: async () => Promise.reject(new Error("build failed")) };
    const harness = await createHarness({ backend: () => failing });

    await harness.writeJson(harness.userConfigFile, { egress: { allow: [], presets: [] } });

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(1);
    expect(harness.stdout().trim().split("\n")).toEqual([
      ...PREPARED,
      "ok proxy: pid 4242 port 3128",
      "fail image: build failed",
      ...HOST_CHECK_LINES,
    ]);
  });

  describe("vm size", () => {
    const RESIZE =
      "colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false --cpu 8 --memory 10";

    const sizeLine = async (size: Vm["size"], machine?: { cpus: number; memoryGiB: number }) => {
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
      const line = harness
        .stdout()
        .split("\n")
        .find((entry) => entry.includes(" vm size: "));

      return { code, line };
    };

    it("warns with the resize command for a 2 CPU, 4 GiB profile without failing doctor", async () => {
      const { code, line } = await sizeLine(async () => ({ cpus: 2, memoryGiB: 4 }));

      expect(line).toBe(
        `warn vm size: profile pi-sandbox has 2 CPUs and 4 GiB, below 8 CPUs and 10 GiB; resize it with ${RESIZE}`,
      );
      expect(code).toBe(0);
    });

    it("measures the profile against the size install.sh gives this machine", async () => {
      const { line } = await sizeLine(async () => ({ cpus: 4, memoryGiB: 4 }), { cpus: 4, memoryGiB: 8 });

      expect(line).toBe("ok vm size: profile pi-sandbox has 4 CPUs and 4 GiB");
    });
  });
});

describe("pi sandbox doctor on the host pi", () => {
  const hostPiLine = async (
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

    return {
      harness,
      line: harness
        .stdout()
        .split("\n")
        .find((entry) => / host pi: /.test(entry)),
    };
  };

  it("names pi's managed install and says the image follows it", async () => {
    const managed = { wrapper: "" };
    const { line } = await hostPiLine(async (harness) => {
      managed.wrapper = (await writeManagedPi(harness.hostAgentDir, "1.6.0")).wrapper;
    });

    expect(line).toBe(`ok host pi: pi 1.6.0, managed install ${managed.wrapper}; the image follows it`);
  });

  it("warns when the managed pi is older than the pi the launcher is tested with", async () => {
    const managed = { wrapper: "" };
    const { line } = await hostPiLine(async (harness) => {
      managed.wrapper = (await writeManagedPi(harness.hostAgentDir, "1.0.0")).wrapper;
    });

    expect(line).toBe(
      `warn host pi: pi 1.0.0 (managed install ${managed.wrapper}) is older than ${await testedPiVersion()}, the pi this launcher is tested with; run pi update`,
    );
  });

  it("fails without a managed pi, even with a pi on PATH, with the missing-pi line", async () => {
    const { harness, line } = await hostPiLine(async (harness) => {
      harness.deps.env.PATH = (await writePathPi(join(harness.root, "brew"), "1.7.0")).bin;
    }, false);

    expect(line).toBe(`fail host pi: ${noHostPiLine(harness.hostAgentDir)}`);
    expect(harness.stdout()).toContain(
      "fail provider hosts: no host pi to read the provider host table with\n",
    );
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

    return harness
      .stdout()
      .split("\n")
      .find((line) => / parent proxy: /.test(line));
  };

  it("connects to an IPv6 http parent proxy without its brackets", async () => {
    expect(await parentLine((port) => `http://[::1]:${port}`)).toMatch(
      /^ok parent proxy: \[::1\]:\d+ accepts connections$/,
    );
  });

  it("fails an https parent proxy, which the launcher proxy does not chain to", async () => {
    expect(await parentLine(() => "https://proxy.example.test")).toBe(
      "fail parent proxy: HTTPS_PROXY uses https, only http parent proxies are supported",
    );
  });
});

describe("pi sandbox doctor mcp sign-in lines", () => {
  it("prints one line per OAuth server from the host pi sign-in store", async () => {
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

    const lines = harness
      .stdout()
      .split("\n")
      .filter((line) => / mcp \S+: /.test(line));

    expect(lines).toEqual([
      "warn mcp docs: needs sign-in: run pi mcp login docs",
      "ok mcp signed: signed in on the host (expires in 2 h)",
    ]);
    expect(harness.stdout()).not.toContain("real-access-token");
  });
});
