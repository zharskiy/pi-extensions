import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plugin, SettingsSchema } from "../../shared/index.ts";
import { createFakeAgentRuntime, createFakeHost, useTempDirs } from "../../test-framework/index.ts";
import { createManagedExtension } from "../managed-extension.ts";

type Settings = { count: number; off: string[] };

type TestPlugin = Plugin<never, unknown, Settings>;

const schema: SettingsSchema<Settings> = {
  count: { type: "number", min: 1, max: 10 },
  off: { type: "list", of: "plugin ids" },
};

const tempDirs = useTempDirs();

const sessionDirs = (userSettings?: unknown) => {
  const agentDir = join(tempDirs.make("managed-extension-"), "agent");

  mkdirSync(agentDir, { recursive: true });

  if (userSettings !== undefined) {
    writeFileSync(join(agentDir, "managed.json"), JSON.stringify(userSettings));
  }

  const host = createFakeHost({ agentDir, cwd: join(agentDir, "..", "project") });

  return { host, runtime: createFakeAgentRuntime(), paths: { root: "/ext/managed", agentDir } };
};

const managed = (plugins: TestPlugin[], extra: { onError?: (error: unknown) => void } = {}) =>
  createManagedExtension({
    namespace: "pi-managed",
    root: "/ext/managed",
    plugins,
    settings: { defaults: () => ({ count: 1, off: [] }), schema, file: "managed.json" },
    disabled: (settings) => settings.off,
    onError: extra.onError,
  });

describe("createManagedExtension", () => {
  it("settings reload runs before plugin session-start handlers", () => {
    const seen: number[] = [];
    const reader: TestPlugin = {
      id: "reader",
      enable: ({ host, settings }) => {
        host.onSessionStart(() => {
          seen.push(settings.count);
        });

        return undefined;
      },
    };
    const { host, runtime, paths } = sessionDirs({ count: 5 });

    managed([reader]).boot(host, runtime, paths);

    expect(seen).toEqual([]);

    host.start();

    expect(seen).toEqual([5]);
  });

  it("reports settings errors once under the namespace and keeps the defaults for invalid values", () => {
    const { host, runtime, paths } = sessionDirs({ count: 50 });
    const { settings } = managed([]).boot(host, runtime, paths);

    host.start();
    host.start();

    expect(settings.count).toBe(1);
    expect(host.notices).toEqual([
      {
        message: `pi-managed settings: ${join(paths.agentDir, "managed.json")}: count must be a number between 1 and 10`,
        level: "warning",
      },
    ]);
  });

  it("hands a custom reload the live settings object and a notifier, then applies boot overrides", () => {
    const { host, runtime, paths } = sessionDirs();
    const extension = createManagedExtension({
      namespace: "pi-managed",
      root: "/ext/managed",
      plugins: [] as TestPlugin[],
      settings: {
        defaults: ({ agentDir }) => ({ count: agentDir.length, off: [] }),
        reload: (settings, info, _runtime, notify) => {
          settings.count = 7;
          notify(`reloaded in ${info.cwd}`);
        },
      },
    });

    const { settings } = extension.boot(host, runtime, paths, { settings: { off: ["x"] } });

    expect(settings).toEqual({ count: paths.agentDir.length, off: ["x"] });

    host.start();

    expect(settings).toEqual({ count: 7, off: ["x"] });
    expect(host.notices).toEqual([
      { message: `pi-managed settings: reloaded in ${host.info.cwd}`, level: "warning" },
    ]);
  });

  it("gives plugins the extension paths and skips the plugins the settings disable", () => {
    const seen: string[] = [];
    const plugin = (id: string): TestPlugin => ({
      id,
      enable: ({ root, paths }) => {
        seen.push(`${id} ${root} ${paths.root} ${paths.agentDir}`);

        return undefined;
      },
    });
    const { host, runtime, paths } = sessionDirs();

    managed([plugin("a"), plugin("b")]).boot(host, runtime, paths, { settings: { off: ["b"] } });

    expect(seen).toEqual([`a /ext/managed /ext/managed ${paths.agentDir}`]);
  });

  it("resolves childExclude entries against the extension root", () => {
    const extension = createManagedExtension({
      namespace: "pi-managed",
      root: "/ext/managed",
      plugins: [],
      childExclude: [".", "src", "/elsewhere"],
    });

    expect(extension.options.childExclude).toEqual(["/ext/managed", "/ext/managed/src", "/elsewhere"]);
    expect(typeof extension).toBe("function");
  });

  it("rethrows errors by default and hands them to onError when given", async () => {
    const failing: TestPlugin = {
      id: "failing",
      enable: () => () => {
        throw new Error("boom");
      },
    };
    const throwing = sessionDirs();

    managed([failing]).boot(throwing.host, throwing.runtime, throwing.paths);
    throwing.host.start();

    await expect(throwing.host.shutdown()).rejects.toThrow("boom");

    const errors: unknown[] = [];
    const reporting = sessionDirs();

    managed([failing], { onError: (error) => errors.push(error) }).boot(
      reporting.host,
      reporting.runtime,
      reporting.paths,
    );
    reporting.host.start();
    await reporting.host.shutdown();

    expect(errors).toHaveLength(1);
  });

  it("lets a boot error from a plugin propagate", () => {
    const broken: TestPlugin = {
      id: "broken",
      enable: () => {
        throw new Error("cannot enable");
      },
    };
    const { host, runtime, paths } = sessionDirs();

    expect(() => managed([broken]).boot(host, runtime, paths)).toThrow("cannot enable");
  });

  it("boots a plain extension with no settings and wraps the host when asked", () => {
    const seen: unknown[] = [];
    const { host, runtime, paths } = sessionDirs();
    const extension = createManagedExtension({
      namespace: "pi-plain",
      root: "/ext/plain",
      host: (inner) => ({ ...inner, ui: { ...inner.ui, notify: () => seen.push("wrapped notify") } }),
      plugins: [
        {
          id: "plain",
          enable: ({ host: wrapped, settings }) => {
            seen.push(settings);
            wrapped.ui.notify("hello", "info");

            return undefined;
          },
        },
      ],
    });

    extension.boot(host, runtime, paths);

    expect(seen).toEqual([undefined, "wrapped notify"]);
    expect(host.notices).toEqual([]);
  });
});
