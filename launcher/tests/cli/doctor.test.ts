import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecIo, ExecSpec, Vm } from "../../backend/index.ts";
import { MCP_LIST_PROBE, OFFLINE_PROBE } from "../../cli/commands/doctor-probes.ts";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { registerLaunch } from "../../grants/index.ts";
import { LauncherError, sha256Hex } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness, unreachable, writeManagedPi, writePathPi } from "./harness.ts";

interface Probes {
  env?: string;
  auth?: string;
  mcp?: string;
  routeExit?: number;
  sameDir?: number;
  offline?: string;
  mcpListExit?: number;
  ruleAnswer?: string;
  mcpAuth?: string;
  settings?: string;
  sessionsExit?: number;
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

type Intent =
  | "repo visible"
  | "environment"
  | "auth file"
  | "mcp file"
  | "direct route"
  | "offline"
  | "mcp list"
  | "rule request"
  | "container mcp-auth"
  | "container settings"
  | "sessions share"
  | "sync";

const isProbe = (command: string[], probe: string[]) => command.join(" ") === probe.join(" ");

const intentOf = (command: string[]): Intent | undefined => {
  const text = command.join(" ");

  if (command[0] === "sh" && text.includes("PI_CODING_AGENT_SESSION_DIR")) {
    return "sessions share";
  }

  if (command[0] === "cat" && text.includes("settings.json")) {
    return "container settings";
  }

  if (
    text.includes("settings.json") ||
    text.includes("pi-sandbox-tmp") ||
    (command[0] === "sh" && text.includes("mcp-auth.json"))
  ) {
    return "sync";
  }

  if (command[0] === "cat" && text.includes("mcp-auth.json")) {
    return "container mcp-auth";
  }

  if (text.includes("auth.json")) {
    return "auth file";
  }

  if (text.includes("mcp.json")) {
    return "mcp file";
  }

  if (isProbe(command, MCP_LIST_PROBE)) {
    return "mcp list";
  }

  if (isProbe(command, OFFLINE_PROBE)) {
    return "offline";
  }

  if (command[0] === "node") {
    return "rule request";
  }

  if (text.includes("1.1.1.1")) {
    return "direct route";
  }

  if (command.some((part) => part.endsWith("/repo"))) {
    return "repo visible";
  }

  return command.length === 1 ? "environment" : undefined;
};

const answering =
  (probes: Probes) =>
  (spec: ExecSpec, io: ExecIo): number => {
    const answers: Record<Intent, () => number> = {
      "repo visible": () => probes.sameDir ?? 0,
      environment: () => {
        io.stdout.write(probes.env ?? "TERM=xterm-256color\nHOME=/home/pi\n");

        return 0;
      },
      "auth file": () => {
        io.stdout.write(probes.auth ?? "{}");

        return 0;
      },
      "mcp file": () => {
        io.stdout.write(probes.mcp ?? "{}");

        return 0;
      },
      "direct route": () => probes.routeExit ?? 1,
      offline: () => {
        io.stdout.write(probes.offline ?? "");

        return probes.offline === undefined ? 1 : 0;
      },
      "mcp list": () => {
        io.stderr.write("docs: connection refused\n");

        return probes.mcpListExit ?? 0;
      },
      "rule request": () => {
        io.stdout.write(`${probes.ruleAnswer ?? "200"}\n`);

        return 0;
      },
      "container mcp-auth": () => {
        io.stdout.write(probes.mcpAuth ?? "{}");

        return 0;
      },
      "container settings": () => {
        io.stdout.write(probes.settings ?? "{}");

        return 0;
      },
      "sessions share": () => probes.sessionsExit ?? 0,
      sync: () => 0,
    };
    const intent = intentOf(spec.command);

    return intent === undefined ? 127 : answers[intent]();
  };

const HOST_CHECK_LINES = [
  expect.stringMatching(/^ok host pi: pi \S+ next to the launcher; the image follows it$/),
  "ok provider hosts: 1 built-in providers with known hosts",
  "skip parent proxy: no parent proxy configured",
  "skip org baseline: no org baseline configured",
  "ok grants: none active",
  expect.stringMatching(/^ok sessions: \/.+\/home\/\.pi\/agent\/sessions\/--.+-repo-- \(host pi lists them/),
];

const PREPARED = ["ok vm", "ok shares", "ok host"];

const VM_LINES = [
  "skip vm shares: colima did not report the shares of profile pi-sandbox",
  "skip vm size: colima did not report the size of profile pi-sandbox",
];

const doctorWith = async (
  probes: Probes,
  healthStatus = 200,
  userConfig?: unknown,
  hostAuth?: unknown,
  vm?: Partial<Vm>,
) => {
  const port = await healthServer(healthStatus);
  const fake = createFakeBackend({ exec: answering(probes), vm });
  const harness = await createHarness({
    backend: () => fake.backend,
    proxy: { ensure: async () => ({ pid: 77, port, policyHash: "p", token: "token-1" }) },
  });

  if (userConfig !== undefined) {
    await harness.writeJson(harness.userConfigFile, userConfig);
  }

  if (hostAuth !== undefined) {
    await harness.writeJson(join(harness.hostAgentDir, "auth.json"), hostAuth);
  }

  const code = await run(["sandbox", "doctor"], harness.deps);
  const lines = harness.stdout().trim().split("\n");

  return { code, lines, fake, harness, port };
};

describe("pi sandbox doctor", () => {
  it("prints one ok line per stage and per check when every probe passes", async () => {
    const { code, lines, harness, port } = await doctorWith({});

    expect(lines).toEqual([
      ...PREPARED,
      `ok proxy: pid 77 port ${port}`,
      expect.stringMatching(/^ok image: ghcr\.io\/zharskiy\/pi-sandbox:\S+ sha256:built-1$/),
      "ok container",
      "ok sync",
      "ok proxy health: /healthz answers",
      `ok same-path mount: ${harness.repoRoot} is mounted at the same path`,
      "ok credential sweep: no credential in the environment, auth.json or mcp.json",
      "ok no-route: no direct route to 1.1.1.1:443",
      "ok offline: PI_OFFLINE is unset",
      "ok mcp: pi mcp list connects to every enabled server",
      "ok mcp-auth sweep: 0 entries in mcp-auth.json, every token is a placeholder",
      "ok settings sweep: no settings.json package carries a credential in its URL",
      "ok sessions share: writable at the host path",
      "skip trust: no credential rule, nothing is terminated",
      ...VM_LINES,
      ...HOST_CHECK_LINES,
    ]);
    expect(code).toBe(0);
  });

  it("runs every probe inside the repository container without a tty, then stops it like a launch", async () => {
    const { fake } = await doctorWith({});
    const probes = fake.execs.filter((exec) => intentOf(exec.spec.command) !== "sync");
    const container = fake.execs[0]?.spec.containerId;

    expect([...new Set(probes.map((exec) => intentOf(exec.spec.command)))].sort()).toEqual([
      "auth file",
      "container mcp-auth",
      "container settings",
      "direct route",
      "environment",
      "mcp file",
      "mcp list",
      "offline",
      "repo visible",
      "sessions share",
    ]);
    expect(fake.execs.every((exec) => exec.spec.containerId === container && !exec.tty)).toBe(true);
    expect([...fake.containers.values()].map((entry) => entry.summary.state)).toEqual(["stopped"]);
  });

  it("checks trust and every credential rule host with its placeholder", async () => {
    const { lines, fake } = await doctorWith({ ruleAnswer: "401" }, 200, undefined, {
      example: { type: "api_key", key: "real-secret-value-1234567890" },
    });
    const request = fake.execs.find((exec) => intentOf(exec.spec.command) === "rule request");

    expect(lines).toContain("ok trust: the container trusts the proxy's certificate for models.example.test");
    expect(lines).toContain(
      "fail rule derived:auth:example:key: https://models.example.test/ answered HTTP 401 with the placeholder",
    );
    expect(request?.spec.command.at(-1)).toMatch(/^Bearer pi-sandbox-[0-9a-f]{24}$/);
    expect(JSON.stringify(fake.execs.map((exec) => exec.spec))).not.toContain("real-secret-value");
  });

  it("fails the trust check on a certificate error and the offline and mcp checks inside", async () => {
    const { code, lines } = await doctorWith(
      { ruleAnswer: "error SELF_SIGNED_CERT_IN_CHAIN", offline: "1", mcpListExit: 1 },
      200,
      undefined,
      { example: { type: "api_key", key: "real-secret-value-1234567890" } },
    );

    expect(lines).toContain("fail trust: models.example.test: SELF_SIGNED_CERT_IN_CHAIN");
    expect(lines).toContain(
      "fail offline: PI_OFFLINE is set in the container, so package installs and updates are off",
    );
    expect(lines).toContain("fail mcp: pi mcp list exited 1: docs: connection refused");
    expect(code).toBe(1);
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

  it("leaves the container running when another launch of the repository is live", async () => {
    const port = await healthServer(200);
    const fake = createFakeBackend({ exec: answering({}) });
    const harness = await createHarness({
      backend: () => fake.backend,
      proxy: { ensure: async () => ({ pid: 77, port, policyHash: "p", token: "token-1" }) },
    });

    await registerLaunch(harness.stateDir, {
      launchId: "00000000000000cc",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
    });

    await run(["sandbox", "doctor"], harness.deps);

    expect(fake.containers.size).toBe(1);
    expect(fake.stops).toEqual([]);
  });

  it("fails the settings sweep on a package whose URL carries a credential", async () => {
    const { code, lines } = await doctorWith({
      settings: JSON.stringify({
        packages: ["npm:fine", { source: "git:https://user:hunter2@git.example.test/team/ext.git" }],
      }),
    });

    expect(lines).toContain(
      "fail settings sweep: settings.json package git.example.test carries a credential in its URL",
    );
    expect(lines.join("\n")).not.toContain("hunter2");
    expect(code).toBe(1);
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

  it("fails when the container reaches the internet directly or the repo is not mounted", async () => {
    const { code, lines } = await doctorWith({ routeExit: 0, sameDir: 1 });

    expect(lines).toContain("fail no-route: 1.1.1.1:443 is reachable directly");
    expect(lines).toContainEqual(expect.stringMatching(/^fail same-path mount: .* is not visible inside$/));
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

  it("shares a missing path through the shares stage and stops when sharing fails", async () => {
    const shared: string[][] = [];
    const { code, lines, fake } = await doctorWith({}, 200, undefined, undefined, {
      ensureShares: async (paths) => {
        shared.push(paths.map((entry) => entry.path));

        throw new LauncherError("/elsewhere is not shared with the sandbox VM");
      },
    });

    expect(lines.slice(0, 2)).toEqual(["ok vm", "fail shares: /elsewhere is not shared with the sandbox VM"]);
    expect(shared).toHaveLength(1);
    expect(fake.containers.size).toBe(0);
    expect(code).toBe(1);
  });

  it("reports the org baseline file it loaded", async () => {
    const down = unreachable(createFakeBackend().backend);
    const harness = await createHarness({ backend: () => down });
    const baseline = join(harness.root, "org.json");

    await harness.writeJson(baseline, {});

    await harness.writeJson(harness.userConfigFile, { org: baseline });

    await run(["sandbox", "doctor"], harness.deps);

    expect(harness.stdout()).toContain(`ok org baseline: ${baseline} loaded\n`);
  });

  it("reports the proxy and image stages both, then stops after a failed image", async () => {
    const fake = createFakeBackend({ exec: answering({}) });
    const failing = { ...fake.backend, buildImage: async () => Promise.reject(new Error("build failed")) };
    const harness = await createHarness({ backend: () => failing });

    await harness.writeJson(harness.userConfigFile, { egress: { allow: [] } });

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(1);
    expect(harness.stdout().trim().split("\n")).toEqual([
      ...PREPARED,
      "ok proxy: not required, no credential rule and an empty allowlist",
      "fail image: build failed",
      ...HOST_CHECK_LINES,
    ]);
  });

  describe("vm size", () => {
    const RESIZE =
      "colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false --cpu 8 --memory 10";

    const sizeLine = async (size: Vm["size"], machine?: { cpus: number; memoryGiB: number }) => {
      const fake = createFakeBackend({ exec: answering({}), vm: { size } });
      const harness = await createHarness({ backend: () => fake.backend, machine });

      await harness.writeJson(harness.userConfigFile, { egress: { allow: [] } });

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

    it("passes for an 8 CPU, 10 GiB profile", async () => {
      const { line } = await sizeLine(async () => ({ cpus: 8, memoryGiB: 10 }));

      expect(line).toBe("ok vm size: profile pi-sandbox has 8 CPUs and 10 GiB");
    });

    it("measures the profile against the size install.sh gives this machine", async () => {
      const { line } = await sizeLine(async () => ({ cpus: 4, memoryGiB: 4 }), { cpus: 4, memoryGiB: 8 });

      expect(line).toBe("ok vm size: profile pi-sandbox has 4 CPUs and 4 GiB");
    });

    it("skips when colima does not report the profile's size", async () => {
      const { line } = await sizeLine(async () => undefined);

      expect(line).toBe("skip vm size: colima did not report the size of profile pi-sandbox");
    });
  });
});

describe("pi sandbox doctor vm shares", () => {
  const sharesLine = async (coverage: Vm["coverage"]) => {
    const fake = createFakeBackend({ exec: answering({}), vm: { coverage } });
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, { egress: { allow: [] } });

    await run(["sandbox", "doctor"], harness.deps);

    const line = harness
      .stdout()
      .split("\n")
      .find((entry) => entry.includes(" vm shares: "));

    return { line, harness };
  };

  it("passes when the profile shares every path of the repository", async () => {
    const asked: string[][] = [];
    const { line, harness } = await sharesLine(async (paths) => {
      asked.push(paths.map((entry) => entry.path));

      return { shares: [{ location: "/Users", writable: true }], missing: [] };
    });

    expect(line).toBe("ok vm shares: profile pi-sandbox shares /Users; this repository is covered");
    expect(asked[0]).toContain(harness.repoRoot);
  });

  it("fails naming the paths the VM does not share", async () => {
    const { line } = await sharesLine(async () => ({ shares: [], missing: ["/srv/repo"] }));

    expect(line).toBe("fail vm shares: /srv/repo is not shared with profile pi-sandbox");
  });

  it("skips when colima did not write the instance config", async () => {
    const { line } = await sharesLine(async () => undefined);

    expect(line).toBe("skip vm shares: colima did not report the shares of profile pi-sandbox");
  });
});

describe("pi sandbox doctor on the host pi", () => {
  const hostPiLine = async (
    prepare: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>,
    bundled = true,
  ) => {
    const down = unreachable(createFakeBackend().backend);
    const harness = await createHarness({ backend: () => down, ...(bundled ? {} : { bundledPi: null }) });

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

  it("names the PATH pi that pi --no-sandbox runs next to the launcher's own pi", async () => {
    const onPath = { pi: "" };
    const { line } = await hostPiLine(async (harness) => {
      const written = await writePathPi(join(harness.root, "brew"), "1.7.0");

      onPath.pi = written.pi;

      harness.deps.env.PATH = written.bin;
    });

    expect(line).toBe(
      `ok host pi: pi ${await testedPiVersion()} next to the launcher; the image follows it; pi --no-sandbox runs pi 1.7.0 at ${onPath.pi}`,
    );
  });

  it("fails when the host has no pi", async () => {
    const { line } = await hostPiLine(async () => undefined, false);

    expect(line).toBe(
      "fail host pi: no pi on the host; install pi or reinstall the launcher with npm install -g pi-extensions-mz",
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
