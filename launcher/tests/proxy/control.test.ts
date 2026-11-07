import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SandboxConfig } from "../../config/index.ts";
import {
  daemonEnv,
  ensureProxyRunning,
  guestProxyUrl,
  proxyPolicyHash,
  readDenials,
  readProxyInstances,
  removeProxyInstance,
  repoProxyToken,
  sendProxyControl,
  stopProxy,
} from "../../proxy/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { CONTROL_USER, openConnect, pageThrough, plainGet, plainRequest, readRest } from "./proxy-client.ts";

const state = { stateDir: "", home: "" };

const config = (allow: string[]): SandboxConfig =>
  sandboxConfig({ fallback: "refuse", egress: { ...sandboxConfig().egress, allow } });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const options = (allow: string[]) => ({
  config: config(allow),
  stateDir: state.stateDir,
  home: state.home,
  env: { ...process.env, PI_SANDBOX_STATE_DIR: state.stateDir },
});

const idlers: ChildProcess[] = [];

const idle = (...marker: string[]) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)", ...marker], {
    stdio: "ignore",
  });

  idlers.push(child);

  return child;
};

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));

const recordHungProxy = async (allow: string[], pid: number) => {
  const dir = instanceDir(allow);

  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, "proxy.json"),
    JSON.stringify({ policyHash: proxyPolicyHash(config(allow)), port: 9, token: "stale", pid }),
  );
};

const loopbackSix = await new Promise<boolean>((resolve) => {
  const probe = createNetServer();

  probe.once("error", () => resolve(false));

  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

const instanceDir = (allow: string[]) => join(state.stateDir, "proxy", proxyPolicyHash(config(allow)));

beforeAll(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-control-"));
  state.home = await mkdtemp(join(tmpdir(), "pi-sandbox-control-home-"));
});

afterEach(async () => {
  await stopProxy(state.stateDir);

  idlers.splice(0).forEach((child) => {
    child.kill("SIGKILL");
  });
});

afterAll(async () => {
  await rm(state.stateDir, { recursive: true, force: true });

  await rm(state.home, { recursive: true, force: true });
});

describe("ensureProxyRunning", () => {
  it("starts one daemon per policy and reuses it while that policy is asked for", async () => {
    const first = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const reused = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const other = await ensureProxyRunning(options(["registry.npmjs.org", "github.com"]));

    expect(first.policyHash).toBe(proxyPolicyHash(config(["registry.npmjs.org"])));
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(reused).toEqual(first);
    expect(other.pid).not.toBe(first.pid);
    expect(other.token).not.toBe(first.token);
    expect(isAlive(first.pid)).toBe(true);
    expect(isAlive(other.pid)).toBe(true);
    expect(new Set((await readProxyInstances(state.stateDir)).map((instance) => instance.pid))).toEqual(
      new Set([first.pid, other.pid]),
    );
  }, 20_000);

  it("answers health only with the instance token", async () => {
    const instance = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const authorized = await plainGet(instance.port, "/healthz", "127.0.0.1", instance.token, CONTROL_USER);
    const anonymous = await plainGet(instance.port, "/healthz");

    expect(JSON.parse(authorized.body)).toMatchObject({ ok: true, pid: instance.pid });
    expect(anonymous.status).toBe(407);
  }, 20_000);

  it("keeps the token in private files and out of the logs", async () => {
    const instance = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const dir = instanceDir(["registry.npmjs.org"]);
    const record = JSON.parse(await readFile(join(dir, "proxy.json"), "utf8"));

    await plainGet(instance.port, "http://evil.test/", "evil.test", instance.token, CONTROL_USER);

    expect(record).toEqual({
      policyHash: instance.policyHash,
      port: instance.port,
      token: instance.token,
      pid: instance.pid,
      listenHosts: [],
    });
    expect((await stat(join(dir, "proxy.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "proxy-config.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "proxy-access.log"), "utf8")).not.toContain(instance.token);
    expect(await readFile(join(dir, "proxy.log"), "utf8").catch(() => "")).not.toContain(instance.token);
    expect(await stat(join(dir, "lock")).catch(() => undefined)).toBeUndefined();
  }, 20_000);

  it("replaces a proxy whose recorded pid no longer answers health", async () => {
    const first = await ensureProxyRunning(options(["registry.npmjs.org"]));

    process.kill(first.pid, "SIGKILL");

    const second = await ensureProxyRunning(options(["registry.npmjs.org"]));

    expect(second.pid).not.toBe(first.pid);
    expect(isAlive(second.pid)).toBe(true);
  }, 20_000);

  it("kills a recorded proxy process that fails health before starting its replacement", async () => {
    const allow = ["registry.npmjs.org"];
    const hung = idle("proxy/daemon", "--hash", proxyPolicyHash(config(allow)));

    await recordHungProxy(allow, hung.pid ?? 0);

    const instance = await ensureProxyRunning(options(allow));

    expect(await exited(hung)).toBe(true);
    expect(instance.pid).not.toBe(hung.pid);
  }, 20_000);

  it("never kills an unrelated process that reuses a recorded pid", async () => {
    const allow = ["registry.npmjs.org"];
    const unrelated = idle();

    await recordHungProxy(allow, unrelated.pid ?? 0);

    await ensureProxyRunning(options(allow));

    expect(isAlive(unrelated.pid ?? 0)).toBe(true);
  }, 20_000);

  it("takes over a lock left by a dead launcher", async () => {
    const dir = instanceDir(["registry.npmjs.org"]);

    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, "lock"), "999999");

    const instance = await ensureProxyRunning(options(["registry.npmjs.org"]));

    expect(isAlive(instance.pid)).toBe(true);
  }, 20_000);

  it("lets only one of two launchers take over a dead launcher's lock", async () => {
    const allow = ["dead-lock.example.com"];
    const dir = instanceDir(allow);

    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, "lock"), "999999");

    const [left, right] = await Promise.all([
      ensureProxyRunning(options(allow)),
      ensureProxyRunning(options(allow)),
    ]);

    expect(right).toEqual(left);
    expect((await readdir(dir)).filter((name) => name.startsWith("lock"))).toEqual([]);
  }, 20_000);

  it("keeps the token of a policy across restarts and gives another policy its own", async () => {
    const first = await ensureProxyRunning(options(["registry.npmjs.org"]));

    await stopProxy(state.stateDir, first.policyHash);

    const restarted = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const other = await ensureProxyRunning(options(["github.com"]));

    expect(restarted.pid).not.toBe(first.pid);
    expect(restarted.token).toBe(first.token);
    expect(other.token).not.toBe(first.token);
    expect((await stat(join(instanceDir(["registry.npmjs.org"]), "proxy-token"))).mode & 0o777).toBe(0o600);
  }, 20_000);

  it("comes back on the same port after it was stopped, so relays that forward to it keep working", async () => {
    const first = await ensureProxyRunning(options(["registry.npmjs.org"]));

    expect(await stopProxy(state.stateDir, first.policyHash)).toBe(1);

    const again = await ensureProxyRunning(options(["registry.npmjs.org"]));

    expect(again.pid).not.toBe(first.pid);
    expect(again.port).toBe(first.port);
  }, 20_000);

  it.skipIf(!loopbackSix)(
    "also listens on a host address the backend asks for, with the same port and token check",
    async () => {
      const plain = await ensureProxyRunning(options(["registry.npmjs.org"]));
      const widened = await ensureProxyRunning({ ...options(["registry.npmjs.org"]), listenHosts: ["::1"] });
      const reused = await ensureProxyRunning({ ...options(["registry.npmjs.org"]), listenHosts: ["::1"] });
      const authorized = await plainRequest(widened.port, "/healthz", {
        address: "::1",
        token: widened.token,
        user: CONTROL_USER,
      });
      const anonymous = await plainRequest(widened.port, "/healthz", { address: "::1" });

      expect(widened.pid).not.toBe(plain.pid);
      expect(widened.port).toBe(plain.port);
      expect(reused.pid).toBe(widened.pid);
      expect(JSON.parse(authorized.body)).toMatchObject({ ok: true, pid: widened.pid });
      expect(anonymous.status).toBe(407);
    },
    20_000,
  );

  it("still starts when an extra host address cannot be bound, and says so in the proxy log", async () => {
    const instance = await ensureProxyRunning({ ...options(["github.com"]), listenHosts: ["192.0.2.1"] });
    const log = await readFile(join(instanceDir(["github.com"]), "proxy.log"), "utf8");

    expect(instance.listenHosts).toEqual(["192.0.2.1"]);
    expect(log).toContain(`proxy cannot also listen on 192.0.2.1:${instance.port}`);
  }, 20_000);

  it("starts a single daemon when two launchers ask at once", async () => {
    const [left, right] = await Promise.all([
      ensureProxyRunning(options(["registry.npmjs.org"])),
      ensureProxyRunning(options(["registry.npmjs.org"])),
    ]);

    expect(right).toEqual(left);
  }, 20_000);
});

describe("stopProxy", () => {
  it("stops one instance by policy hash or all of them, and counts what it stopped", async () => {
    const first = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const other = await ensureProxyRunning(options(["github.com"]));

    expect(await stopProxy(state.stateDir, first.policyHash)).toBe(1);
    expect(isAlive(first.pid)).toBe(false);
    expect(isAlive(other.pid)).toBe(true);
    expect((await readProxyInstances(state.stateDir)).map((instance) => instance.pid)).toEqual([other.pid]);
    expect(await stopProxy(state.stateDir)).toBe(1);
    expect(isAlive(other.pid)).toBe(false);
    expect(await readProxyInstances(state.stateDir)).toEqual([]);
    expect(await stopProxy(state.stateDir)).toBe(0);
  }, 20_000);
});

describe("removeProxyInstance", () => {
  it("stops the instance and removes its directory, so the next start gets a new token", async () => {
    const first = await ensureProxyRunning(options(["registry.npmjs.org"]));

    expect(await removeProxyInstance(state.stateDir, first.policyHash)).toBe(true);
    expect(isAlive(first.pid)).toBe(false);
    expect(await stat(instanceDir(["registry.npmjs.org"])).catch(() => undefined)).toBeUndefined();
    expect(await removeProxyInstance(state.stateDir, first.policyHash)).toBe(false);

    const rotated = await ensureProxyRunning(options(["registry.npmjs.org"]));

    expect(rotated.token).not.toBe(first.token);
  }, 20_000);
});

describe("stopProxy on a hung instance", () => {
  it("kills a recorded proxy process that no longer answers health", async () => {
    const allow = ["registry.npmjs.org"];
    const hung = idle("proxy/daemon", "--hash", proxyPolicyHash(config(allow)));

    await recordHungProxy(allow, hung.pid ?? 0);

    expect(await stopProxy(state.stateDir)).toBe(1);
    expect(await exited(hung)).toBe(true);
  }, 20_000);
});

describe("control socket and repository tokens", () => {
  const repoHash = "4".repeat(64);

  it("takes env secrets from the launcher and serves a repository its denials", async () => {
    const instance = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const token = await repoProxyToken(state.stateDir, instance.policyHash, repoHash);
    const page = await pageThrough(instance.port, "evil.test:443", token);

    expect(
      await sendProxyControl(instance, {
        type: "env-secrets",
        secrets: { rule: "value" },
        repoTokenHash: sha256Hex(token),
      }),
    ).toEqual({ ok: true });
    expect(await sendProxyControl(instance, { type: "env-secrets", secrets: { rule: "value" } })).toEqual({
      ok: false,
      error: "the control message names no live repository token",
    });
    expect(page).toMatchObject({ connect: 200, status: 403 });
    expect(page.body).toBe("pi-sandbox: evil.test is not allowed; run pi sandbox egress allow evil.test");
    expect(await readDenials(state.stateDir, instance.policyHash, { repoHash, since: 0 })).toContainEqual(
      expect.objectContaining({ host: "evil.test", repoHash, rule: "egress.allow" }),
    );
    expect((await stat(join(instanceDir(["registry.npmjs.org"]), "tokens", repoHash))).mode & 0o777).toBe(
      0o600,
    );
  }, 20_000);

  it("refuses the instance token for tunnels", async () => {
    const instance = await ensureProxyRunning(options(["registry.npmjs.org"]));
    const reply = await openConnect(instance.port, "registry.npmjs.org:443", instance.token);

    await readRest(reply.socket);

    expect(reply.status).toBe(407);
  }, 20_000);

  it("gives a capped configuration its own policy instance", async () => {
    const capped = await ensureProxyRunning({
      ...options(["registry.npmjs.org"]),
      egressCap: { grants: [] },
    });

    expect(capped.policyHash).toBe(proxyPolicyHash(config(["registry.npmjs.org"]), { grants: [] }));
    expect(capped.policyHash).not.toBe(proxyPolicyHash(config(["registry.npmjs.org"])));
  }, 20_000);
});

describe("daemon environment", () => {
  it("spawns the daemon with a minimal env and hands the parent proxy address through its config", async () => {
    const spawned: Array<NodeJS.ProcessEnv | undefined> = [];
    const allow = ["env.example.test"];
    const outcome = await ensureProxyRunning({
      ...options(allow),
      env: {
        PATH: "/usr/bin",
        HOME: state.home,
        GATEWAY_KEY: "secret",
        HTTPS_PROXY: "http://corp:pass@proxy.test:3128",
      },
      timeoutMs: 100,
      spawn: (_command, _args, spawnOptions) => {
        spawned.push(spawnOptions.env);

        return idle();
      },
    }).catch((error: Error) => error);
    const daemonConfig = JSON.parse(
      await readFile(join(instanceDir(allow), "proxy-config.json"), "utf8"),
    ) as {
      parentEnv: Record<string, string>;
    };

    expect(outcome).toBeInstanceOf(Error);
    expect(spawned[0]).toEqual({ PATH: "/usr/bin", HOME: state.home });
    expect(daemonConfig.parentEnv).toEqual({ HTTPS_PROXY: "http://proxy.test:3128" });
  }, 20_000);

  it("passes only the variables the daemon needs, never secrets, and strips proxy userinfo", () => {
    const env = daemonEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TMPDIR: "/tmp",
      NODE_OPTIONS: "--require /fixture/resolve.cjs",
      PI_SANDBOX_STATE_DIR: "/state",
      CORP_TOKEN: "secret-value",
      HTTP_PROXY: "http://user:pw@proxy.example.test:8080",
      HTTPS_PROXY: "http://user:pw@proxy.example.test:8080",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TMPDIR: "/tmp",
      NODE_OPTIONS: "--require /fixture/resolve.cjs",
      PI_SANDBOX_STATE_DIR: "/state",
      HTTPS_PROXY: "http://proxy.example.test:8080",
    });
  });
});

describe("guestProxyUrl", () => {
  it("puts the instance token into the proxy URL for the route address", () => {
    const route = { network: { kind: "internal", name: "pi-sandbox" }, address: "10.89.0.2:3128" };

    expect(guestProxyUrl(route, "t0k")).toBe("http://pi-sandbox:t0k@10.89.0.2:3128");
  });
});
