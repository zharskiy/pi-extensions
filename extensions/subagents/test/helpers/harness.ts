import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll } from "vitest";
import {
  catalogModel,
  createFakeHost,
  createFakeRuntime,
  type FakeHost,
  flush,
} from "../../../../core/test/helpers/fakes.ts";
import { createExtensionManager } from "../../../../extension-manager/index.ts";
import type { AgentRuntime } from "../../../../pi-adapter/index.ts";
import { NAMESPACE } from "../../src/model/paths.ts";
import type { Plugin } from "../../src/model/plugin.ts";
import { defaultSettings, type Settings } from "../../src/model/settings.ts";
import type { RunAgentParams } from "../../src/plugins/run-agent/render.ts";

export const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

const created: string[] = [];

afterAll(() => {
  created.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

export const tempDir = (prefix = "pi-subagents-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  created.push(dir);

  return dir;
};

const shippedModels = () =>
  [
    ...new Set(
      readdirSync(join(PACKAGE_ROOT, "agents"), { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".md"))
        .flatMap((file) =>
          readFileSync(join(PACKAGE_ROOT, "agents", file), "utf8")
            .split("\n")
            .flatMap((line) => /^model:\s*([^\s:]+)/.exec(line)?.[1] ?? []),
        ),
    ),
  ].map((ref) => catalogModel(ref));

export const wakeTexts = (host: FakeHost) => host.hidden.map((entry) => entry.message.text);

export const startPlugins = <R extends AgentRuntime>(
  host: FakeHost,
  runtime: R,
  plugins: Plugin[],
  overrides: Partial<Settings> = {},
) => {
  created.push(join(tmpdir(), NAMESPACE, host.info.id));

  const settings = { ...defaultSettings(), renderThrottleMs: 0, ...overrides };
  const errors: unknown[] = [];

  const manager = createExtensionManager({
    host,
    runtime,
    settings,
    plugins,
    root: PACKAGE_ROOT,
    disabled: settings.disabledPlugins,
    onError: (error) => errors.push(error),
  });

  host.start();

  return { host, runtime, settings, manager, errors, services: manager.services, bus: manager.bus };
};

type BeforeStart = (context: {
  root: string;
  host: FakeHost;
  runtime: ReturnType<typeof createFakeRuntime>;
}) => void;

type HarnessOptions = { overrides?: Partial<Settings>; beforeStart?: BeforeStart };

export const createHarness = (plugins: Plugin[], { overrides = {}, beforeStart }: HarnessOptions = {}) => {
  const root = tempDir();

  const host = createFakeHost({
    id: basename(root),
    file: join(root, "sessions", "main.jsonl"),
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
  });

  const runtime = createFakeRuntime(shippedModels());

  beforeStart?.({ root, host, runtime });

  return { root, ...startPlugins(host, runtime, plugins, overrides) };
};

export const spawnAgents = async (
  harness: Pick<ReturnType<typeof startPlugins>, "host" | "services">,
  count: number,
) => {
  const agents = Array.from({ length: count }, (_, index) => ({ agent: "scout", task: `job ${index}` }));

  await harness.host.tool<RunAgentParams, unknown>("run_agent").execute({ agents }, { update: () => {} });
  await flush();
  harness.host.settle();

  return harness.services.require("registry").list();
};
