import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../../../../platform/pi-adapter/index.ts";
import { fallbackStemsRoot, RUN_MANIFEST, runsDir } from "../../../../platform/shared/index.ts";
import { createFakeHost, useTempDirs } from "../../../../test/framework/index.ts";
import { readLive } from "../../core/live-markers.ts";
import { sweep } from "../../core/prune.ts";
import { apply } from "../../core/sweep-apply.ts";
import { cutoffAt, type Plan, plan } from "../../core/sweep-plan.ts";
import { scan } from "../../core/sweep-scan.ts";

const DAY_MS = 86_400_000;

const NOW = Math.floor(Date.now() / 1000) * 1000;

export const daysAgo = (days: number) => NOW - days * DAY_MS;

export const OLD = daysAgo(90);

export const RECENT = daysAgo(5);

export const CUTOFF = daysAgo(60);

export const MANIFEST_FILE = RUN_MANIFEST;

const temp = useTempDirs();

export const touch = (path: string, time: number) => {
  utimesSync(path, new Date(time), new Date(time));
};

type Manifest = Record<string, unknown> | string | false;

const manifestText = (id: string, manifest: Record<string, unknown> | string) =>
  typeof manifest === "string" ? manifest : JSON.stringify({ id, state: "running", ...manifest });

export const runFiles = (dir: string, id: string, touched: number, manifest: Manifest = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.md"), "done\n");
  writeFileSync(join(dir, "child.jsonl"), "{}\n");

  if (manifest !== false) {
    writeFileSync(join(dir, MANIFEST_FILE), manifestText(id, manifest));
  }

  readdirSync(dir).forEach((name) => {
    touch(join(dir, name), touched);
  });
  touch(dir, touched);

  return dir;
};

type Options = {
  days?: number;
  now?: number;
  isAlive?: (pid: number) => boolean;
  current?: Partial<SessionInfo>;
};

export const fabricate = () => {
  const root = temp.make("pi-prune-");
  const agentDir = join(root, "agent");
  const sessionsRoot = join(agentDir, "sessions");
  const slugDir = join(sessionsRoot, "--project--");
  const handoffRoot = join(root, "pi-handoff");
  const host = createFakeHost({ agentDir });

  mkdirSync(handoffRoot, { mode: 0o700 });

  const agentsDir = (stem: string) => runsDir(join(slugDir, stem));

  const sessionIn = (dir: string, stem: string, touched = NOW, parentSession?: string) => {
    const file = join(dir, `${stem}.jsonl`);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: stem, cwd: root, parentSession })}\n`,
    );
    touch(file, touched);

    return file;
  };

  const session = (stem: string, touched = NOW, parentSession?: string) =>
    sessionIn(slugDir, stem, touched, parentSession);

  const unreadable = (stem: string, text: string) => {
    const file = join(slugDir, `${stem}.jsonl`);

    mkdirSync(slugDir, { recursive: true });
    writeFileSync(file, text);
    touch(file, OLD);

    return file;
  };

  const run = (stem: string, id: string, touched = NOW, manifest: Manifest = {}) =>
    runFiles(join(agentsDir(stem), id), id, touched, manifest);

  const fallbackRun = (sessionId: string, id: string, touched = NOW) =>
    runFiles(join(runsDir(join(fallbackStemsRoot(agentDir), sessionId)), id), id, touched);

  const handoff = (sessionId: string, touched = NOW) => {
    const dir = join(handoffRoot, sessionId);
    const file = join(dir, "main-handoff.md");

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "## Status\n");
    touch(file, touched);
    touch(dir, touched);

    return dir;
  };

  const empty = (name: string, touched = daysAgo(2)) => {
    const dir = join(handoffRoot, name);

    mkdirSync(dir);
    touch(dir, touched);

    return dir;
  };

  const marker = (sessionId: string, pid: number, data: Record<string, unknown> = {}) => {
    const file = join(agentDir, "pi-prune", "live", `${sessionId}.${pid}.json`);

    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ id: sessionId, pid, file: null, parentSession: null, ...data }));

    return file;
  };

  const input = (options: Options = {}) => {
    const current = { agentDir, id: "current-id", ...options.current };
    const isAlive = options.isAlive ?? (() => false);

    return {
      agentDir,
      handoffRoot,
      live: () => readLive(current, isAlive),
      days: options.days ?? 60,
      now: options.now ?? NOW,
    };
  };

  const raw = (options: Options = {}) => {
    const sources = input(options);

    return scan(sources, cutoffAt(sources.now, sources.days), sources.now);
  };

  const aborted = async (options: Options = {}) => {
    const scanned = await raw(options);

    return typeof scanned === "string" ? scanned : undefined;
  };

  const scanned = async (options: Options = {}) => {
    const result = await raw(options);

    if (typeof result === "string") {
      throw new Error(result);
    }

    return result;
  };

  const planned = async (options: Options = {}) => {
    const sources = input(options);

    return plan(await scanned(options), cutoffAt(sources.now, sources.days));
  };

  const applied = (result: Plan, options: Options = {}) => apply(result, input(options).live);

  const prune = async (options: Options = {}) => applied(await planned(options), options);

  const swept = (options: Options = {}) => {
    const sources = input(options);

    return sweep(sources, sources.days, sources.now);
  };

  return {
    root,
    agentDir,
    sessionsRoot,
    slugDir,
    handoffRoot,
    host,
    agentsDir,
    sessionIn,
    session,
    unreadable,
    run,
    fallbackRun,
    handoff,
    empty,
    marker,
    input,
    aborted,
    scanned,
    planned,
    applied,
    prune,
    swept,
  };
};
