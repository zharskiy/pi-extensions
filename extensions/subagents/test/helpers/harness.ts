import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";
import type { AgentRuntime } from "../../../../core/adapter/contract.ts";
import { createExtensionManager } from "../../../../core/manager/extension-manager.ts";
import { createFakeHost, createFakeRuntime, type FakeHost } from "../../../../core/test/helpers/fakes.ts";
import type { Plugin } from "../../src/model/plugin.ts";
import { applySettings, defaultSettings, type Settings } from "../../src/model/settings.ts";

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

export const startPlugins = <R extends AgentRuntime>(
  host: FakeHost,
  runtime: R,
  plugins: Plugin[],
  overrides: Partial<Settings> = {},
) => {
  const settings = applySettings(defaultSettings(), { renderThrottleMs: 0, ...overrides });
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

export const createHarness = (plugins: Plugin[], overrides: Partial<Settings> = {}) => {
  const root = tempDir();

  const host = createFakeHost({
    id: "main-session",
    file: join(root, "sessions", "main.jsonl"),
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
  });

  return { root, ...startPlugins(host, createFakeRuntime(), plugins, overrides) };
};
