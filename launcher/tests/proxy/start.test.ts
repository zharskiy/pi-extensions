import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endLaunch, newLaunchId, registerLaunch, withRepoLaunchLock } from "../../grants/index.ts";
import { watchIdle } from "../../proxy/idle.ts";
import {
  ensureRepoProxy,
  guestProxyUrl,
  PROXY_LOG_LIMIT,
  type RepoProxyInput,
  readDenials,
  readRepoProxy,
  repoProxyToken,
  stopRepoProxy,
} from "../../proxy/index.ts";
import { bootTime, processMark, processStart, stateLayout } from "../../shared/index.ts";
import { openConnect, plainGet } from "./proxy-client.ts";

const REPO = "1".repeat(64);

const OTHER = "2".repeat(64);

const SECRET = "env-secret-value-0123456789";

const EGRESS_CHANGED =
  "the network allow and deny settings changed and now apply to every pi running in this folder";

const FAILING_DAEMON = [
  'console.error("2026-01-01T00:00:00.000Z pi-sandbox-proxy failed: broken input (fix the input)");',
  'console.error("2026-01-01T00:00:01.000Z pi mcp login: waiting for the browser");',
  "process.exit(1);",
].join(" ");

const state = { stateDir: "" };

const idlers: ChildProcess[] = [];

const files = (repoHash = REPO) => stateLayout(state.stateDir).repo(repoHash).proxy;

const inputFor = async (
  overrides: Partial<RepoProxyInput> = {},
  repoHash = REPO,
): Promise<RepoProxyInput> => ({
  repoHash,
  token: await repoProxyToken(state.stateDir, repoHash),
  allow: ["registry.npmjs.org"],
  deny: [],
  privateHosts: [],
  rules: [],
  derivedHosts: [],
  envSecrets: { corp: SECRET },
  parentEnv: {},
  extraCa: false,
  piCommand: [],
  hostAgentDir: join(state.stateDir, "agent"),
  accessLogLimit: PROXY_LOG_LIMIT,
  ...overrides,
});

const ensure = async (input: RepoProxyInput, othersLive = false) =>
  ensureRepoProxy({
    stateDir: state.stateDir,
    input,
    env: process.env,
    othersLive: async () => othersLive,
  });

const isAlive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

const idle = () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });

  idlers.push(child);

  return child;
};

const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)]),
    ),
  );

  return nested.flat();
};

beforeAll(async () => {
  state.stateDir = await mkdtemp(join(tmpdir(), "pi-sandbox-start-"));
});

afterEach(async () => {
  await Promise.all([REPO, OTHER].map((hash) => stopRepoProxy(state.stateDir, hash)));

  idlers.splice(0).forEach((child) => {
    child.kill("SIGKILL");
  });
});

afterAll(async () => {
  await rm(state.stateDir, { recursive: true, force: true });
});

describe("ensureRepoProxy", () => {
  it("starts one daemon per repository and reuses it while the input is the same", async () => {
    const input = await inputFor();
    const first = await ensure(input);
    const reused = await ensure(input);
    const other = await ensure(await inputFor({}, OTHER));

    expect(first.proxy).toMatchObject({ pid: expect.any(Number), port: expect.any(Number) });
    expect(Math.abs(first.proxy.boot - bootTime())).toBeLessThanOrEqual(1);
    expect(reused.proxy).toEqual(first.proxy);
    expect(other.proxy.pid).not.toBe(first.proxy.pid);
    expect(await readRepoProxy(state.stateDir, REPO)).toEqual(first.proxy);
    expect((await stat(files().record)).mode & 0o777).toBe(0o600);
    expect((await stat(files().token)).mode & 0o777).toBe(0o600);
  }, 20_000);

  it("takes env secrets on stdin and never writes them to the state dir", async () => {
    await ensure(await inputFor());

    const texts = await Promise.all(
      (await filesUnder(state.stateDir)).map((file) => readFile(file, "latin1")),
    );

    expect(texts.some((text) => text.includes(SECRET))).toBe(false);
  }, 20_000);

  it("answers health and denials only with the repository token", async () => {
    const input = await inputFor({ deny: ["blocked.test"] });
    const { proxy } = await ensure(input);

    expect((await plainGet(proxy.port, "/healthz", "127.0.0.1", "f".repeat(64))).status).toBe(407);
    expect(JSON.parse((await plainGet(proxy.port, "/healthz", "127.0.0.1", input.token)).body)).toEqual({
      ok: true,
      pid: proxy.pid,
    });

    const refused = await openConnect(proxy.port, "blocked.test:443", input.token);

    refused.socket.destroy();

    expect(refused.status).toBe(403);
    expect((await readDenials(state.stateDir, REPO, 0)).map((denial) => denial.host)).toEqual([
      "blocked.test",
    ]);
  }, 20_000);

  it("keeps a proxy whose credentials changed while other launches live, with a notice, and replaces it after", async () => {
    const input = await inputFor();
    const first = await ensure(input);
    const changed = await inputFor({ piCommand: ["other-pi"] });
    const kept = await ensure(changed, true);

    expect(kept.proxy).toEqual(first.proxy);
    expect(kept.notices).toEqual([
      "the credential, parent proxy or CA settings changed; the pi sessions running in this folder keep the earlier ones until they all exit (egress allow and deny changes apply now)",
    ]);

    const replaced = await ensure(changed);

    expect(replaced.proxy.pid).not.toBe(first.proxy.pid);
    expect(changed.token).toBe(input.token);
    expect((await plainGet(replaced.proxy.port, "/healthz", "127.0.0.1", input.token)).status).toBe(200);
  }, 20_000);

  it("applies tightened and loosened egress settings to the running proxy without a restart or a notice", async () => {
    const denied = async (port: number, token: string, host: string) => {
      const since = Date.now();
      const reply = await openConnect(port, `${host}:443`, token);

      reply.socket.destroy();

      return (await readDenials(state.stateDir, REPO, since)).find((denial) => denial.host === host)?.rule;
    };
    const input = await inputFor({ allow: ["kept.invalid"] });
    const first = await ensure(input);

    expect(await denied(first.proxy.port, input.token, "kept.invalid")).toBeUndefined();
    expect(await denied(first.proxy.port, input.token, "added.invalid")).toBe("egress.allow");

    const tightened = await ensure(await inputFor({ allow: ["kept.invalid"], deny: ["kept.invalid"] }), true);

    expect(tightened).toEqual({ proxy: first.proxy, notices: [EGRESS_CHANGED] });
    expect(await denied(first.proxy.port, input.token, "kept.invalid")).toBe("egress.deny");

    const loosened = await ensure(await inputFor({ allow: ["kept.invalid", "added.invalid"] }), true);

    expect(loosened).toEqual({ proxy: first.proxy, notices: [EGRESS_CHANGED] });
    expect(await denied(first.proxy.port, input.token, "kept.invalid")).toBeUndefined();
    expect(await denied(first.proxy.port, input.token, "added.invalid")).toBeUndefined();
  }, 20_000);

  it("names a changed egress.json only when other sessions of the folder are live", async () => {
    const first = await ensure(await inputFor({ allow: ["a.invalid"] }));
    const unchanged = await ensure(await inputFor({ allow: ["a.invalid"] }), true);
    const changedAlone = await ensure(await inputFor({ allow: ["b.invalid"] }));
    const changedShared = await ensure(await inputFor({ allow: ["c.invalid"] }), true);

    expect(first.notices).toEqual([]);
    expect(unchanged.notices).toEqual([]);
    expect(changedAlone.notices).toEqual([]);
    expect(changedShared.notices).toEqual([EGRESS_CHANGED]);
  }, 20_000);

  it("restarts when the extra CA file changed", async () => {
    const extraPem = stateLayout(state.stateDir).extraPem;

    await mkdir(join(extraPem, ".."), { recursive: true });

    await writeFile(extraPem, "first\n");

    const first = await ensure(await inputFor({ extraCa: true }));

    await writeFile(extraPem, "second\n");

    const kept = await ensure(await inputFor({ extraCa: true }), true);
    const replaced = await ensure(await inputFor({ extraCa: true }));

    expect(kept.notices).toHaveLength(1);
    expect(replaced.proxy.pid).not.toBe(first.proxy.pid);
  }, 20_000);

  it("restarts when only an env secret value changed", async () => {
    const first = await ensure(await inputFor());
    const rotated = await ensure(await inputFor({ envSecrets: { corp: "rotated-value" } }));

    expect(rotated.proxy.pid).not.toBe(first.proxy.pid);
  }, 20_000);

  it("never kills a live process that only reuses the recorded pid, and starts a fresh proxy", async () => {
    const stranger = idle();

    await once(stranger, "spawn");

    await mkdir(files().directory, { recursive: true });

    await writeFile(
      files().record,
      JSON.stringify({
        pid: stranger.pid,
        boot: bootTime(),
        start: "Thu-Jan-1-00:00:00-1970",
        port: 9,
        inputHash: "old",
      }),
    );

    const started = await ensure(await inputFor());

    expect(started.proxy.pid).not.toBe(stranger.pid);
    expect(isAlive(stranger)).toBe(true);
  }, 20_000);
});

describe("ensureRepoProxy start and health", () => {
  it("starts the daemon in its proxy dir and names its own failure line in the error, not another writer's", async () => {
    const seen: Array<string | undefined> = [];
    const failing = ensureRepoProxy({
      stateDir: state.stateDir,
      input: await inputFor(),
      env: process.env,
      othersLive: async () => false,
      spawn: (_command, _args, options) => {
        seen.push(String(options.cwd));

        return spawn(process.execPath, ["-e", FAILING_DAEMON], {
          ...options,
          stdio: ["pipe", "ignore", options.stdio?.[2] ?? "ignore"],
        } as SpawnOptions);
      },
    });

    await expect(failing).rejects.toThrow(
      "the pi-sandbox egress proxy did not become healthy: broken input (fix the input)",
    );
    expect(seen).toEqual([files().directory]);
  }, 20_000);

  it("retries a health check before it gives up on a live recorded proxy", async () => {
    const stranger = idle();

    await once(stranger, "spawn");

    const answers = { count: 0 };
    const health = createServer((_request, response) => {
      answers.count += 1;

      if (answers.count === 1) {
        response.writeHead(503).end();

        return;
      }

      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, pid: stranger.pid }));
    });

    await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", () => resolve()));

    await mkdir(files().directory, { recursive: true });

    await writeFile(
      files().record,
      JSON.stringify({
        pid: stranger.pid,
        boot: bootTime(),
        start: await processStart(stranger.pid ?? 0),
        port: (health.address() as AddressInfo).port,
        inputHash: "old",
      }),
    );

    const kept = await ensure(await inputFor(), true);

    health.close();

    expect(kept.proxy.pid).toBe(stranger.pid);
    expect(answers.count).toBe(2);
    expect(isAlive(stranger)).toBe(true);

    await rm(files().record, { force: true });
  }, 20_000);
});

describe("stopRepoProxy", () => {
  it("stops the daemon and removes its record", async () => {
    const { proxy } = await ensure(await inputFor());

    expect(await stopRepoProxy(state.stateDir, REPO)).toBe(true);
    expect(await readRepoProxy(state.stateDir, REPO)).toBeUndefined();
    expect(await stat(files().record).catch(() => undefined)).toBeUndefined();
    expect(() => process.kill(proxy.pid, "SIGCONT")).toThrow();
    expect(await stopRepoProxy(state.stateDir, REPO)).toBe(false);
  }, 20_000);
});

describe("watchIdle", () => {
  it("waits for the launch lock, so a launch that registers while it is held keeps the proxy up", async () => {
    const outcome = { idle: false };
    const launch = {
      launchId: newLaunchId(),
      ...(await processMark()),
      repoHash: REPO,
      startedAt: 1,
    };
    const held: { watch?: ReturnType<typeof watchIdle>; pending?: ReturnType<typeof registerLaunch> } = {};

    await withRepoLaunchLock(state.stateDir, REPO, async () => {
      held.watch = watchIdle({
        stateDir: state.stateDir,
        repoHash: REPO,
        intervalMs: 30,
        emptyChecks: 2,
        onIdle: async () => {
          outcome.idle = true;
        },
      });

      held.pending = registerLaunch(state.stateDir, launch);

      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    await held.pending;

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(outcome.idle).toBe(false);

    await endLaunch(state.stateDir, {
      repoHash: REPO,
      launchId: launch.launchId,
      onLast: async () => undefined,
    });

    await held.watch?.idle;

    expect(outcome.idle).toBe(true);
  });
});

describe("guestProxyUrl", () => {
  it("names the route address and carries the repository token", () => {
    expect(guestProxyUrl({ address: "pi-sandbox-proxy:3128" }, "t0k3n")).toBe(
      "http://pi-sandbox:t0k3n@pi-sandbox-proxy:3128",
    );
  });
});
