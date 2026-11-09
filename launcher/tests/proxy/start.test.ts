import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
import { bootTime, stateLayout } from "../../shared/index.ts";
import { openConnect, plainGet } from "./proxy-client.ts";

const REPO = "1".repeat(64);

const OTHER = "2".repeat(64);

const SECRET = "env-secret-value-0123456789";

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
  grants: true,
  rules: [],
  derivedHosts: [],
  envSecrets: { corp: SECRET },
  parent: "none",
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

  it("keeps a changed proxy while other launches live, with a notice, and replaces it with the same token after", async () => {
    const input = await inputFor();
    const first = await ensure(input);
    const changed = await inputFor({ allow: ["github.com"] });
    const kept = await ensure(changed, true);

    expect(kept.proxy).toEqual(first.proxy);
    expect(kept.notices).toEqual([
      "the egress settings or environment secrets changed; they apply after every session in this repository exits",
    ]);

    const replaced = await ensure(changed);

    expect(replaced.proxy.pid).not.toBe(first.proxy.pid);
    expect(changed.token).toBe(input.token);
    expect((await plainGet(replaced.proxy.port, "/healthz", "127.0.0.1", input.token)).status).toBe(200);
  }, 20_000);

  it("restarts when only an env secret value changed", async () => {
    const first = await ensure(await inputFor());
    const rotated = await ensure(await inputFor({ envSecrets: { corp: "rotated-value" } }));

    expect(rotated.proxy.pid).not.toBe(first.proxy.pid);
  }, 20_000);

  it("never kills a live process whose record stopped its heartbeat, and starts a fresh proxy", async () => {
    const stranger = idle();
    const old = new Date(Date.now() - 120_000);

    await mkdir(files().directory, { recursive: true });

    await writeFile(
      files().record,
      JSON.stringify({ pid: stranger.pid, boot: bootTime(), port: 9, inputHash: "old" }),
    );

    await utimes(files().record, old, old);

    const started = await ensure(await inputFor());

    expect(started.proxy.pid).not.toBe(stranger.pid);
    expect(isAlive(stranger)).toBe(true);
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
      pid: process.pid,
      boot: bootTime(),
      repoHash: REPO,
      startedAt: 1,
    };
    const held: { watch?: ReturnType<typeof watchIdle>; pending?: ReturnType<typeof registerLaunch> } = {};

    await withRepoLaunchLock(state.stateDir, REPO, async () => {
      held.watch = watchIdle({
        stateDir: state.stateDir,
        repoHash: REPO,
        intervalMs: 100,
        emptyChecks: 2,
        onIdle: async () => {
          outcome.idle = true;
        },
      });

      held.pending = registerLaunch(state.stateDir, launch);

      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    const registered = await held.pending;

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(outcome.idle).toBe(false);

    await endLaunch(state.stateDir, {
      repoHash: REPO,
      launchId: launch.launchId,
      onLast: async () => undefined,
    });

    registered?.stopHeartbeat();

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
