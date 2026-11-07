import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecIo, ExecSpec } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness } from "./harness.ts";

interface Probes {
  env?: string;
  auth?: string;
  mcp?: string;
  routeExit?: number;
  sameDir?: number;
  offline?: string;
  mcpListExit?: number;
  ruleAnswer?: string;
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
  | "sync";

const intentOf = (command: string[]): Intent | undefined => {
  const text = command.join(" ");

  if (text.includes("settings.json") || text.includes("pi-sandbox-tmp")) {
    return "sync";
  }

  if (text.includes("auth.json")) {
    return "auth file";
  }

  if (text.includes("mcp.json")) {
    return "mcp file";
  }

  if (text === "pi mcp list") {
    return "mcp list";
  }

  if (command[0] === "printenv") {
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
      sync: () => 0,
    };
    const intent = intentOf(spec.command);

    return intent === undefined ? 127 : answers[intent]();
  };

const GATEWAY = {
  url: "https://gateway.example.com",
  authHeader: "x-api-key",
  placeholder: "pi-sandbox-placeholder",
  providers: [{ id: "gateway", apiKind: "example-messages" }],
};

const HOST_LINES = [
  expect.stringMatching(/^ok bundled pi: pi \S+, the same as the image$/),
  "ok provider hosts: 1 built-in providers with known hosts",
  "skip parent proxy: no parent proxy configured",
  "skip org baseline: no org baseline configured",
  "ok grants: none active",
];

const doctorWith = async (probes: Probes, healthStatus = 200, userConfig?: unknown, hostAuth?: unknown) => {
  const port = await healthServer(healthStatus);
  const fake = createFakeBackend({ exec: answering(probes) });
  const harness = await createHarness({
    adapters: () => [fake.backend],
    proxy: { ensure: async () => ({ pid: 77, port, policyHash: "p", token: "token-1" }) },
  });

  cleanups.push(harness.cleanup);

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
  it("prints one ok line per check when every probe passes", async () => {
    const { code, lines, harness, port } = await doctorWith({});

    expect(lines).toEqual([
      "ok runtime: colima fake",
      `ok proxy: pid 77 port ${port}, /healthz answers`,
      expect.stringMatching(/^ok image: ghcr\.io\/zharskiy\/pi-sandbox:\S+ sha256:built-1$/),
      `ok same-path mount: ${harness.repoRoot} is mounted at the same path`,
      "ok credential sweep: no credential in the environment, auth.json or mcp.json",
      "ok no-route: no direct route to 1.1.1.1:443",
      "ok offline: PI_OFFLINE is unset",
      "ok mcp: pi mcp list connects to every enabled server",
      "skip trust: no credential rule, nothing is terminated",
      ...HOST_LINES,
    ]);
    expect(code).toBe(0);
  });

  it("runs every probe inside the repository container without a tty, then removes the container it created", async () => {
    const { fake } = await doctorWith({});
    const probes = fake.execs.filter((exec) => intentOf(exec.spec.command) !== "sync");
    const container = fake.execs[0]?.spec.containerId;

    expect([...new Set(probes.map((exec) => intentOf(exec.spec.command)))].sort()).toEqual([
      "auth file",
      "direct route",
      "environment",
      "mcp file",
      "mcp list",
      "offline",
      "repo visible",
    ]);
    expect(fake.execs.every((exec) => exec.spec.containerId === container && !exec.tty)).toBe(true);
    expect(fake.containers.size).toBe(0);
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
      auth: JSON.stringify({ gateway: { type: "api_key", key: "real-secret-value-1234567890" } }),
    });
    const sweep = lines.find((line) => line.startsWith("fail credential sweep")) ?? "";

    expect(sweep).toBe(
      [
        "fail credential sweep: environment variable GATEWAY_API_KEY holds a value other than the placeholder",
        "/home/pi/.pi/agent/auth.json holds a value other than the placeholder at gateway.key",
      ].join("; "),
    );
    expect(lines.join("\n")).not.toContain("real-secret-value-1234567890");
    expect(code).toBe(1);
  });

  it("passes the sweep when secret-named variables and auth.json hold only the placeholder", async () => {
    const { lines } = await doctorWith(
      {
        env: "TERM=xterm\nGATEWAY_API_KEY=pi-sandbox-placeholder\nSESSION_TOKEN=\n",
        auth: JSON.stringify({ gateway: { type: "api_key", key: "pi-sandbox-placeholder" } }),
      },
      200,
      { gateway: GATEWAY },
    );

    expect(lines).toContain("ok credential sweep: no credential in the environment, auth.json or mcp.json");
  });

  it("fails when the container reaches the internet directly or the repo is not mounted", async () => {
    const { code, lines } = await doctorWith({ routeExit: 0, sameDir: 1 });

    expect(lines).toContain("fail no-route: 1.1.1.1:443 is reachable directly");
    expect(lines).toContainEqual(expect.stringMatching(/^fail same-path mount: .* is not visible inside$/));
    expect(code).toBe(1);
  });

  it("fails the proxy check when /healthz does not answer", async () => {
    const { code, lines } = await doctorWith({}, 503);

    expect(lines[1]).toMatch(/^fail proxy: pid 77 port \d+, \/healthz does not answer$/);
    expect(code).toBe(1);
  });

  it("skips every check after the runtime when no backend is available and still exits 1", async () => {
    const fake = createFakeBackend();
    const down = { ...fake.backend, detect: async () => ({ available: false, reason: "socket missing" }) };
    const harness = await createHarness({ adapters: () => [down] });

    cleanups.push(harness.cleanup);

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(1);

    const lines = harness.stdout().trim().split("\n");

    expect(lines[0]).toMatch(/^fail runtime: no sandbox backend available: colima \(socket missing\)/);
    expect(lines.slice(1)).toEqual([
      "skip proxy: no runtime",
      "skip image: no runtime",
      "skip same-path mount: no runtime",
      "skip credential sweep: no runtime",
      "skip no-route: no runtime",
      "skip offline: no runtime",
      "skip mcp: no runtime",
      "skip trust: no runtime",
      ...HOST_LINES,
    ]);
  });

  it("does not count skipped checks as failures", async () => {
    const fake = createFakeBackend({ exec: answering({}) });
    const failing = { ...fake.backend, buildImage: async () => Promise.reject(new Error("build failed")) };
    const harness = await createHarness({ adapters: () => [failing] });

    cleanups.push(harness.cleanup);

    await harness.writeJson(harness.userConfigFile, { egress: { allow: [] } });

    expect(await run(["sandbox", "doctor"], harness.deps)).toBe(1);
    expect(harness.stdout().trim().split("\n").slice(1)).toEqual([
      "ok proxy: not required, no gateway, no credential rule and an empty allowlist",
      "fail image: build failed",
      "skip same-path mount: no image",
      "skip credential sweep: no image",
      "skip no-route: no image",
      "skip offline: no image",
      "skip mcp: no image",
      "skip trust: no image",
      ...HOST_LINES,
    ]);
  });
});
