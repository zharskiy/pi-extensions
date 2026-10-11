import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExtensionManager } from "../../src/manager/extension-manager.ts";
import type { Plugin } from "../../src/manager/plugin.ts";
import { applySettings, defaultSettings, type Settings } from "../../src/manager/settings.ts";
import { createFakeHost, createFakeRuntime } from "./fakes.ts";

export const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

export const tempDir = (prefix = "pi-subagents-") => mkdtempSync(join(tmpdir(), prefix));

export const createHarness = (plugins: Plugin[], overrides: Partial<Settings> = {}) => {
  const root = tempDir();

  const host = createFakeHost({
    id: "main-session",
    file: join(root, "sessions", "main.jsonl"),
    dir: join(root, "sessions"),
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
  });

  const runtime = createFakeRuntime();
  const settings = applySettings(defaultSettings(), { renderThrottleMs: 0, ...overrides });
  const errors: unknown[] = [];

  const manager = createExtensionManager({
    host,
    runtime,
    settings,
    plugins,
    packageRoot: PACKAGE_ROOT,
    onError: (error) => errors.push(error),
  });

  host.start();

  return { root, host, runtime, settings, manager, errors, services: manager.services, bus: manager.bus };
};
