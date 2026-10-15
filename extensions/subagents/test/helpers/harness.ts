import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll } from "vitest";
import type { AgentRuntime } from "../../../../core/adapter/contract.ts";
import { createExtensionManager } from "../../../../core/manager/extension-manager.ts";
import { createFakeHost, createFakeRuntime, type FakeHost } from "../../../../core/test/helpers/fakes.ts";
import { NAMESPACE } from "../../src/model/paths.ts";
import type { Plugin } from "../../src/model/plugin.ts";
import { defaultSettings, type Settings } from "../../src/model/settings.ts";

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

const FAKE_MODELS: Record<string, string> = { luna: "beta/nova-6-luna", sol: "beta/nova-6.1-sol" };

const fakeModelLine = (line: string) =>
  line.replace(
    /^model: \S*-(luna|sol)(:\S+)?$/,
    (_, family: string, thinking = "") => `model: ${FAKE_MODELS[family]}${thinking}`,
  );

const fakeRoot = () => {
  const dir = tempDir("pi-subagents-root-");

  symlinkSync(join(PACKAGE_ROOT, "prompts"), join(dir, "prompts"));
  cpSync(join(PACKAGE_ROOT, "agents"), join(dir, "agents"), { recursive: true });

  readdirSync(join(dir, "agents")).forEach((file) => {
    const path = join(dir, "agents", file);

    writeFileSync(path, readFileSync(path, "utf8").split("\n").map(fakeModelLine).join("\n"));
  });

  return dir;
};

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
    root: fakeRoot(),
    disabled: settings.disabledPlugins,
    onError: (error) => errors.push(error),
  });

  host.start();

  return { host, runtime, settings, manager, errors, services: manager.services, bus: manager.bus };
};

export const createHarness = (plugins: Plugin[], overrides: Partial<Settings> = {}) => {
  const root = tempDir();

  const host = createFakeHost({
    id: basename(root),
    file: join(root, "sessions", "main.jsonl"),
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
  });

  return { root, ...startPlugins(host, createFakeRuntime(), plugins, overrides) };
};
