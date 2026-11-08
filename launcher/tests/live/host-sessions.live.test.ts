import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locateBundledPi } from "../../hostpi/index.ts";
import { hostSessionsDir } from "../../workspace/index.ts";
import { conversationText, type LlmFixture, startLlmFixture } from "./fixtures/llm-fixture.ts";
import { listContainers } from "./harness/engine.ts";
import { FIXTURE_HOSTS } from "./harness/names.ts";
import {
  createLiveSandbox,
  type LiveSandbox,
  liveEnabled,
  type PiResult,
  type PiRun,
} from "./harness/sandbox.ts";
import {
  fixtureConfig,
  MODEL_ARGS,
  providerModels,
  providerSettings,
  randomSecret,
  waitFor,
} from "./harness/scenario.ts";

const REPLY = "host sessions reply from the fixture";

const LAUNCHER_ENTRY = fileURLToPath(new URL("../../bin/pi-sandbox-dev.js", import.meta.url));

const TIMEOUT_MS = 540_000;

const HOLD_PROMPT = "hold this session open until the test releases it";

const HOLD_ARRIVAL_MS = 300_000;

const HOLD_SETTLE_MS = 60_000;

interface Hold {
  arrived: boolean;
  release(): void;
  released: Promise<void>;
}

const createHold = (): Hold => {
  const gate: { open?: () => void } = {};
  const released = new Promise<void>((resolve) => {
    gate.open = resolve;
  });

  return { arrived: false, released, release: () => gate.open?.() };
};

const settle = async (run: PiRun) => {
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const ended = await Promise.race([
    run.done.then(() => true),
    new Promise<boolean>((resolve) => {
      timer.handle = setTimeout(() => resolve(false), HOLD_SETTLE_MS);
    }),
  ]);

  clearTimeout(timer.handle);

  if (!ended) {
    run.stop();
  }

  return run.done;
};

interface SessionHeader {
  id: string;
  cwd: string;
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const sessionFiles = async (dir: string) =>
  (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl")).sort();

const headerOf = async (file: string) =>
  JSON.parse((await readFile(file, "utf8")).split("\n")[0] ?? "{}") as SessionHeader;

const agentContainer = async (sandbox: LiveSandbox) =>
  (await listContainers({ "pi-sandbox.repo-hash": sandbox.repoHash })).find(
    (container) => container.Labels["pi-sandbox.relay"] !== "true",
  );

const piIn = (sandbox: LiveSandbox, cwd: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<PiResult>((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER_ENTRY, ...args], {
      cwd,
      env: { ...sandbox.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.once("close", (code) => {
      clearTimeout(timer);

      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

const hostPiBin = async (sandbox: LiveSandbox) => {
  const bundled = await locateBundledPi();
  const bin = join(sandbox.root, "host-bin");
  const quoted = (bundled?.command ?? []).map((part) => `'${part}'`).join(" ");

  await mkdir(bin, { recursive: true });

  await writeFile(join(bin, "pi"), `#!/bin/sh\nexec ${quoted} "$@"\n`);

  await chmod(join(bin, "pi"), 0o755);

  return { PATH: `${bin}:${sandbox.env.PATH ?? ""}` };
};

describe.skipIf(!liveEnabled)("pi sessions in the host session directory (live)", () => {
  const apiKey = randomSecret("fixture-host-sessions-key");
  const state: {
    sandbox?: LiveSandbox;
    llm?: LlmFixture;
    hostEnv?: Record<string, string>;
    dir?: string;
    sandboxed?: string;
    hold?: Hold;
  } = {};

  const sandboxOf = () => state.sandbox as LiveSandbox;

  const dirOf = () => state.dir as string;

  const hostPi = (args: string[]) =>
    piIn(sandboxOf(), sandboxOf().repo, ["--no-sandbox", ...args], state.hostEnv);

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("host-sessions");

    state.sandbox = sandbox;

    state.llm = await startLlmFixture(sandbox.certificate, apiKey, async (request) => {
      const hold = state.hold;

      if (hold !== undefined && conversationText(request).includes(HOLD_PROMPT)) {
        hold.arrived = true;

        await hold.released;
      }

      return { text: REPLY };
    });

    await sandbox.writeAgentFile("models.json", providerModels(state.llm.baseUrl(FIXTURE_HOSTS.llm), apiKey));

    await sandbox.writeAgentFile("settings.json", providerSettings());

    await sandbox.writeUserConfig(fixtureConfig(sandbox));

    state.hostEnv = await hostPiBin(sandbox);

    state.dir = hostSessionsDir(sandbox.agentDir, sandbox.repo);
  }, 120_000);

  afterAll(async () => {
    await state.llm?.close();

    await state.sandbox?.cleanup();
  }, 120_000);

  it("host pi reaches the fixture and writes its session to the repository's slug directory", async () => {
    const result = await hostPi(["-p", "hi", ...MODEL_ARGS]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(REPLY);
    expect(await readdir(join(sandboxOf().agentDir, "sessions"))).toEqual([basename(dirOf())]);
    expect(await sessionFiles(dirOf())).toHaveLength(1);
  });

  it("sandboxed pi writes a new session to the same directory, owned by the host user, with the repository as cwd", async () => {
    const before = await sessionFiles(dirOf());
    const result = await sandboxOf().pi(["-p", "hi", ...MODEL_ARGS]).done;
    const added = (await sessionFiles(dirOf())).filter((name) => !before.includes(name));
    const file = join(dirOf(), added[0] ?? "missing");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(REPLY);
    expect(added).toHaveLength(1);
    expect((await headerOf(file)).cwd).toBe(sandboxOf().repo);
    expect((await stat(file)).uid).toBe(process.getuid?.());

    state.sandboxed = file;
  });

  it("host pi lists and resumes the sandboxed session by an 8-character id prefix", async () => {
    const file = state.sandboxed as string;
    const header = await headerOf(file);
    const size = (await stat(file)).size;
    const result = await hostPi(["--session", header.id.slice(0, 8), "-p", "again", ...MODEL_ARGS]);

    expect(result.code).toBe(0);
    expect((await stat(file)).size).toBeGreaterThan(size);
  });

  it("shows the sandbox only this repository's slug under the sessions directory", async () => {
    const other = join(sandboxOf().agentDir, "sessions", "--other--");

    await mkdir(other, { recursive: true });

    await writeFile(
      join(other, "x.jsonl"),
      `${JSON.stringify({ type: "session", id: "x", cwd: "/elsewhere" })}\n`,
    );

    const listing = await sandboxOf().exec(`ls -a '${join(sandboxOf().agentDir, "sessions")}'`);
    const read = await sandboxOf().exec(`cat '${join(other, "x.jsonl")}'`);

    expect(listing.stdout.split("\n").filter((name) => name !== "" && name !== "." && name !== "..")).toEqual(
      [basename(dirOf())],
    );
    expect(read.code).not.toBe(0);
  });

  it("sweeps links and fifos when a run exits and the planted agents link when the container stops", async () => {
    const dir = dirOf();
    const stem = (state.sandboxed as string).replace(/\.jsonl$/, "");
    const target = join(sandboxOf().root, "agents-target");
    const hold = createHold();

    await mkdir(target, { recursive: true });

    await writeFile(join(target, "kept.txt"), "kept\n");

    state.hold = hold;

    const held = sandboxOf().pi(["-p", HOLD_PROMPT, ...MODEL_ARGS]);

    try {
      await waitFor(() => (hold.arrived ? true : undefined), HOLD_ARRIVAL_MS);

      const planted = await sandboxOf().exec(
        [
          `ln -s /etc/passwd '${dir}/l.jsonl'`,
          `mkfifo '${dir}/f.jsonl'`,
          `rm -rf '${stem}/agents'`,
          `mkdir -p '${stem}'`,
          `ln -s '${target}' '${stem}/agents'`,
        ].join(" && "),
      );

      expect(planted.code).toBe(0);
      expect(await exists(join(dir, "l.jsonl"))).toBe(true);

      const result = await sandboxOf().pi(["-p", "hi", ...MODEL_ARGS]).done;

      expect(result.code).toBe(0);
      expect(await exists(join(dir, "l.jsonl"))).toBe(false);
      expect(await exists(join(dir, "f.jsonl"))).toBe(false);
      expect((await agentContainer(sandboxOf()))?.State).toBe("running");
      expect((await lstat(join(stem, "agents"))).isSymbolicLink()).toBe(true);

      hold.release();

      const last = await settle(held);

      expect(last.code).toBe(0);
      expect((await agentContainer(sandboxOf()))?.State).not.toBe("running");
      expect(await exists(join(stem, "agents"))).toBe(false);
      expect(await readFile(join(target, "kept.txt"), "utf8")).toBe("kept\n");
    } finally {
      hold.release();

      await settle(held);

      state.hold = undefined;
    }
  }, 900_000);

  it("renames a session whose header names a cwd outside the repository", async () => {
    const forged = join(dirOf(), "forged.jsonl");
    const planted = await sandboxOf().exec(
      `printf '%s\\n' '${JSON.stringify({ type: "session", id: "forged", cwd: "/etc" })}' > '${forged}'`,
    );

    expect(planted.code).toBe(0);

    const result = await sandboxOf().pi(["-p", "hi", ...MODEL_ARGS]).done;

    const entries = await readdir(dirOf());
    const rejected = entries.filter((name) => /^forged\.jsonl\.rejected-[0-9a-f]{8}$/.test(name));

    expect(result.code).toBe(0);
    expect(entries.filter((name) => name.startsWith("forged") && name.endsWith(".jsonl"))).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(result.stderr).toContain(
      `pi-sandbox: sessions: ${forged} names a cwd outside the repository; renamed to ${rejected[0]}`,
    );
  });

  it("puts a session started in a subdirectory into the repository root's slug with the subdirectory as cwd", async () => {
    const sub = join(sandboxOf().repo, "sub");
    const before = await sessionFiles(dirOf());

    await mkdir(sub, { recursive: true });

    const result = await piIn(sandboxOf(), sub, ["-p", "hi", ...MODEL_ARGS]);
    const added = (await sessionFiles(dirOf())).filter((name) => !before.includes(name));

    expect(result.code).toBe(0);
    expect(added).toHaveLength(1);
    expect((await headerOf(join(dirOf(), added[0] ?? "missing"))).cwd).toBe(sub);
    expect(await exists(hostSessionsDir(sandboxOf().agentDir, sub))).toBe(false);
  });

  it("recreates the container and keeps sessions in the volume once sessions.host is off", async () => {
    const statusOn = await sandboxOf().pi(["sandbox", "status"]).done;
    const before = await agentContainer(sandboxOf());
    const files = await sessionFiles(dirOf());

    expect(statusOn.stdout).toContain(`session dir: ${dirOf()}\n`);

    await sandboxOf().writeUserConfig({ ...fixtureConfig(sandboxOf()), sessions: { host: false } });

    const result = await sandboxOf().pi(["-p", "hi", ...MODEL_ARGS]).done;
    const after = await agentContainer(sandboxOf());
    const statusOff = await sandboxOf().pi(["sandbox", "status"]).done;

    expect(result.code).toBe(0);
    expect(after?.Id).not.toBe(before?.Id);
    expect(after?.Labels["pi-sandbox.spec-hash"]).not.toBe(before?.Labels["pi-sandbox.spec-hash"]);
    expect(await sessionFiles(dirOf())).toEqual(files);
    expect(statusOff.stdout).toContain("session dir: sandbox volume (sessions.host is off)\n");
  });
});
