import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentRuntime } from "../../../../platform/pi-adapter/index.ts";
import {
  catalogModel,
  createFakeAgentRuntime,
  createFakeHost,
  type FakeAgentRuntime,
  type FakeHost,
  flushMicrotasks,
  startExtension,
  useTempDirs,
} from "../../../../test/framework/index.ts";
import { NAMESPACE, userAgentsDir } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { defaultSettings, type Settings } from "../../core/model/settings.ts";
import type { RunAgentParams } from "../../core/run-agent/tools.ts";

export const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

const tempDirs = useTempDirs();

export const tempDir = (prefix = "pi-subagents-") => tempDirs.make(prefix);

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

const AGENT_FIELDS = { description: "d", limit: "50000", tools: "all", skills: "all", subagents: "[]" };

export const agentFile = (name: string, fields: Record<string, string> = {}, body = "") => {
  const lines = Object.entries({ name, ...AGENT_FIELDS, ...fields }).map(
    ([key, value]) => `${key}: ${value}`,
  );

  return `---\n${lines.join("\n")}\n---\n${body}`;
};

export const writeUserAgent = (host: Pick<FakeHost, "info">, name: string, text = agentFile(name)) => {
  const dir = userAgentsDir(host.info);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), text);
};

export const pluginSettings = (overrides: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(),
  renderThrottleMs: 0,
  ...overrides,
});

export const startPlugins = <R extends AgentRuntime>(
  host: FakeHost,
  runtime: R,
  plugins: Plugin[],
  overrides: Partial<Settings> = {},
) => {
  tempDirs.track(join(tmpdir(), NAMESPACE, host.info.id));

  const settings = pluginSettings(overrides);

  return startExtension({
    plugins,
    settings,
    root: PACKAGE_ROOT,
    runtime,
    host,
    disabled: settings.disabledPlugins,
  });
};

type BeforeStart = (context: { root: string; host: FakeHost; runtime: FakeAgentRuntime }) => void;

type HarnessOptions = { overrides?: Partial<Settings>; beforeStart?: BeforeStart };

export const createHarness = (plugins: Plugin[], { overrides = {}, beforeStart }: HarnessOptions = {}) => {
  const root = tempDir();

  const host = createFakeHost({
    id: basename(root),
    file: join(root, "sessions", "main.jsonl"),
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
  });

  const runtime = createFakeAgentRuntime(shippedModels());

  beforeStart?.({ root, host, runtime });

  return { ...startPlugins(host, runtime, plugins, overrides), root };
};

export const spawnAgents = async (
  harness: Pick<ReturnType<typeof startPlugins>, "host" | "services">,
  count: number,
) => {
  const agents = Array.from({ length: count }, (_, index) => ({ agent: "scout", task: `job ${index}` }));

  await harness.host.tool<RunAgentParams, unknown>("run_agent").execute({ agents }, {});
  await flushMicrotasks();
  harness.host.settle();

  return harness.services.require("registry").list();
};
