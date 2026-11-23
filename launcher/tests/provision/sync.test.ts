import { chmod, lstat, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCapture } from "../../backend/index.ts";
import { syncVolumeFiles } from "../../provision/index.ts";
import {
  BUILT_IN_WRITE_BACK,
  GUEST_PATHS,
  readJsonObject,
  stateLayout,
  type WriteBackTable,
} from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir, writeText } from "./fixtures.ts";

const setup = async () => {
  const stateDir = await tempDir("write-back-state");
  const repoRoot = await tempDir("write-back-repo");
  const hostAgentDir = await tempDir("write-back-host");
  const guestAgentDir = await tempDir("write-back-volume");
  const fake = createFakeBackend({ guestAgentDir });
  const containerId = await runningContainer(fake.backend);
  const synced = (readTimeoutMs?: number, allowlist: WriteBackTable = BUILT_IN_WRITE_BACK) =>
    syncVolumeFiles({
      backend: fake.backend,
      containerId,
      stateDir,
      hostAgentDir,
      workspaceRoot: repoRoot,
      allowlist,
      readTimeoutMs,
    });
  const sync = async (readTimeoutMs?: number, allowlist?: WriteBackTable) => {
    const { changes, notices } = await synced(readTimeoutMs, allowlist);

    return { changes, notices };
  };
  const host = async (name: string) => readJsonObject(join(hostAgentDir, name));
  const volume = async (name: string) => {
    const text = await fake.guestFile(name);

    return text === undefined ? undefined : JSON.parse(text);
  };
  const writeHost = (name: string, value: unknown) =>
    writeText(join(hostAgentDir, name), JSON.stringify(value));
  const writeVolume = (name: string, value: unknown) =>
    fake.writeGuestFile(name, typeof value === "string" ? value : JSON.stringify(value));
  const baseline = () => readJsonObject(stateLayout(stateDir).sync.baseline);

  const guestShell = (script: string, name: string) =>
    execCapture(fake.backend, {
      containerId,
      command: ["sh", "-c", script, "sh", join(GUEST_PATHS.agentDir, name)],
      env: {},
      workdir: "/",
    });

  return {
    stateDir,
    containerId,
    hostAgentDir,
    guestAgentDir,
    fake,
    sync,
    synced,
    host,
    volume,
    writeHost,
    writeVolume,
    baseline,
    guestShell,
  };
};

const FOOTER: WriteBackTable = {
  ...BUILT_IN_WRITE_BACK,
  "pi-footer.json": { layout: { type: "json" } },
};

const LIST_CHANGED =
  "the write-back list changed; nothing is written back from sessions started under the old list";

describe("syncVolumeFiles with a configured allowlist", () => {
  it("copies an added pi-*.json into the sandbox and writes its listed keys back", async () => {
    const env = await setup();

    await env.writeHost("pi-footer.json", { layout: "wide", secret: "host" });

    await env.sync(undefined, FOOTER);

    expect(await env.volume("pi-footer.json")).toEqual({ layout: "wide", secret: "host" });

    await env.writeVolume("pi-footer.json", { layout: "narrow", secret: "planted" });

    expect((await env.sync(undefined, FOOTER)).changes).toEqual([
      "pi-footer.json layout: wide → narrow written to the host",
    ]);
    expect(await env.host("pi-footer.json")).toEqual({ layout: "narrow", secret: "host" });
  });

  it("writes back no excluded key and checks a key with its configured spec", async () => {
    const env = await setup();
    const allowlist: WriteBackTable = {
      ...BUILT_IN_WRITE_BACK,
      "settings.json": { editorPaddingX: { type: "integer", min: 0, max: 8 } },
    };

    await env.writeHost("settings.json", { theme: "a", editorPaddingX: 1 });

    await env.sync(undefined, allowlist);

    await env.writeVolume("settings.json", { theme: "b", editorPaddingX: 9 });

    expect(await env.sync(undefined, allowlist)).toEqual({
      changes: [],
      notices: ["settings.json: editorPaddingX in the sandbox is not a valid value; not written back"],
    });

    await env.writeVolume("settings.json", { theme: "b", editorPaddingX: 4 });

    expect((await env.sync(undefined, allowlist)).changes).toEqual([
      "settings.json editorPaddingX: 1 → 4 written to the host",
    ]);
    expect(await env.host("settings.json")).toEqual({ theme: "a", editorPaddingX: 4 });
  });

  it("writes nothing back with an empty allowlist, and still copies the extension files in", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });
    await env.writeHost("pi-style.json", { style: "plain" });

    await env.sync(undefined, {});

    await env.writeVolume("settings.json", { theme: "b" });
    await env.writeVolume("pi-style.json", { style: "terse" });

    expect(await env.sync(undefined, {})).toEqual({ changes: [], notices: [] });
    expect(await env.host("settings.json")).toEqual({ theme: "a" });
    expect(await env.volume("pi-style.json")).toEqual({ style: "plain" });
  });

  it("resets the baseline when the allowlist changes, so the first sync after it writes nothing back", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    const before = await env.baseline();

    await env.writeVolume("settings.json", { theme: "b" });

    expect(await env.sync(undefined, FOOTER)).toEqual({ changes: [], notices: [LIST_CHANGED] });
    expect(await env.host("settings.json")).toEqual({ theme: "a" });

    const after = await env.baseline();

    expect(after?.allowlist).not.toEqual(before?.allowlist);
    expect(Object.keys((after?.files ?? {}) as object)).toContain("pi-footer.json");

    await env.writeVolume("settings.json", { theme: "c" });

    expect((await env.sync(undefined, FOOTER)).changes).toEqual([
      "settings.json theme: a → c written to the host",
    ]);
  });
});

describe("syncVolumeFiles with a list that drops an added file", () => {
  it("removes the copy of a file that left the list, and of every added file once write-back is off", async () => {
    const env = await setup();

    await env.writeHost("pi-footer.json", { layout: "wide", token: "host" });
    await env.writeHost("pi-style.json", { style: "plain" });

    await env.sync(undefined, FOOTER);

    expect(await env.volume("pi-footer.json")).toEqual({ layout: "wide", token: "host" });

    await env.sync();

    expect(await env.volume("pi-footer.json")).toBeUndefined();

    await env.sync(undefined, FOOTER);

    expect(await env.volume("pi-footer.json")).toEqual({ layout: "wide", token: "host" });

    await env.sync(undefined, {});

    expect(await env.volume("pi-footer.json")).toBeUndefined();
    expect(await env.volume("pi-style.json")).toEqual({ style: "plain" });
  });

  it("keeps a pi-*.json the launcher never copied, and removes nothing after a baseline without the copied list", async () => {
    const env = await setup();

    await env.writeHost("pi-footer.json", { layout: "wide" });
    await env.writeVolume("pi-made-inside.json", { mode: "sandbox" });

    await env.sync();

    expect(await env.volume("pi-made-inside.json")).toEqual({ mode: "sandbox" });

    await env.sync(undefined, FOOTER);
    await writeText(
      stateLayout(env.stateDir).sync.baseline,
      JSON.stringify({ allowlist: "older", files: {} }),
    );

    await env.sync();

    expect(await env.volume("pi-footer.json")).toEqual({ layout: "wide" });
    expect(await env.volume("pi-made-inside.json")).toEqual({ mode: "sandbox" });
  });

  it("says once that changes made under the old list are not written back", async () => {
    const env = await setup();
    const narrowed: WriteBackTable = {
      ...BUILT_IN_WRITE_BACK,
      "settings.json": { theme: { type: "fileName" } },
    };

    await env.writeHost("settings.json", { theme: "dark" });

    await env.sync();

    await env.writeVolume("settings.json", { theme: "light" });

    expect(await env.sync(undefined, narrowed)).toEqual({ changes: [], notices: [LIST_CHANGED] });
    expect(await env.sync()).toEqual({ changes: [], notices: [LIST_CHANGED] });
    expect(await env.sync()).toEqual({ changes: [], notices: [] });
    expect(await env.host("settings.json")).toEqual({ theme: "dark" });
  });
});

describe("syncVolumeFiles write-back", () => {
  it("writes nothing back on the first sync and records what it wrote as the baseline", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "host", packages: ["npm:a"] });
    await env.writeHost("pi-style.json", { style: "terse" });
    await env.writeVolume("settings.json", { theme: "stale" });

    expect(await env.sync()).toEqual({ changes: [], notices: [] });
    expect(await env.host("settings.json")).toEqual({ theme: "host", packages: ["npm:a"] });
    expect(await env.volume("settings.json")).toEqual({ theme: "host", packages: ["npm:a"] });
    expect(await env.volume("pi-style.json")).toEqual({ style: "terse" });
    expect((await env.baseline())?.files).toEqual({
      "settings.json": { theme: "host" },
      "pi-subagents.json": {},
      "pi-style.json": { style: "terse" },
      "pi-notifications.json": {},
      "pi-session-limits.json": {},
      "pi-prune.json": {},
    });
  });

  it("writes a sandbox change of an allowlisted key back and keeps every other host key", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { defaultModel: "p/a", packages: ["npm:a"], shellPath: "/bin/zsh" });

    await env.sync();

    await env.writeVolume("settings.json", {
      defaultModel: "p/b",
      packages: ["npm:planted"],
      shellPath: "/tmp/planted",
      npmCommand: ["sh", "-c", "planted"],
    });

    expect(await env.sync()).toEqual({
      changes: ["settings.json defaultModel: p/a → p/b written to the host"],
      notices: [],
    });
    expect(await env.host("settings.json")).toEqual({
      defaultModel: "p/b",
      packages: ["npm:a"],
      shellPath: "/bin/zsh",
    });
    expect(await env.volume("settings.json")).toEqual({ defaultModel: "p/b", packages: ["npm:a"] });
  });

  it("keeps the host value when both sides changed a key, and the sandbox starts from it", async () => {
    const env = await setup();

    await env.writeHost("pi-notifications.json", { channel: "auto", idleDelayMs: 1 });

    await env.sync();

    await env.writeHost("pi-notifications.json", { channel: "bell", idleDelayMs: 1 });

    await env.writeVolume("pi-notifications.json", { channel: "off", idleDelayMs: 2 });

    expect(await env.sync()).toEqual({
      changes: ["pi-notifications.json idleDelayMs: 1 → 2 written to the host"],
      notices: ["pi-notifications.json: channel changed on the host and in the sandbox; kept the host value"],
    });
    expect(await env.host("pi-notifications.json")).toEqual({ channel: "bell", idleDelayMs: 2 });
    expect(await env.volume("pi-notifications.json")).toEqual({ channel: "bell", idleDelayMs: 2 });
  });

  it("creates a missing host pi-*.json only when the sandbox has one, and removes a stale volume copy", async () => {
    const env = await setup();

    await env.writeVolume("pi-session-limits.json", { softRatio: 0.3 });

    await env.sync();

    expect(await env.volume("pi-session-limits.json")).toBeUndefined();

    await env.writeVolume("pi-style.json", { style: "terse", extra: 1 });

    expect((await env.sync()).changes).toEqual(["pi-style.json style: (unset) → terse written to the host"]);
    expect(await env.host("pi-style.json")).toEqual({ style: "terse" });
    expect(await env.host("pi-session-limits.json")).toBeUndefined();
  });

  it("removes a key on the host that the sandbox deleted", async () => {
    const env = await setup();

    await env.writeHost("pi-subagents.json", { maxDepth: 3, disabledPlugins: ["agent-view"] });

    await env.sync();

    await env.writeVolume("pi-subagents.json", { disabledPlugins: [] });

    expect((await env.sync()).changes).toEqual([
      "pi-subagents.json maxDepth: 3 → (unset) written to the host",
    ]);
    expect(await env.host("pi-subagents.json")).toEqual({ disabledPlugins: ["agent-view"] });
  });

  it("skips a volume file that is not a JSON object or is too large, and a host file that is broken", async () => {
    const env = await setup();

    await env.writeHost("pi-style.json", { style: "a" });
    await env.writeHost("pi-subagents.json", { maxDepth: 3 });
    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    await env.writeVolume("pi-style.json", "[1]");
    await env.writeVolume("pi-subagents.json", { agents: { big: "x".repeat(70_000) } });
    await env.writeVolume("settings.json", { theme: "b" });
    await writeText(join(env.hostAgentDir, "settings.json"), "{ broken");

    const result = await env.sync();

    expect(result.changes).toEqual([]);
    expect(result.notices).toEqual([
      "settings.json on the host is not a JSON object; not written back",
      "pi-subagents.json in the sandbox is larger than 64 KiB; not written back",
      "pi-style.json in the sandbox is not a JSON object; not written back",
    ]);
    expect(await env.host("pi-style.json")).toEqual({ style: "a" });
    expect(await env.host("pi-subagents.json")).toEqual({ maxDepth: 3 });
    expect(await readFile(join(env.hostAgentDir, "settings.json"), "utf8")).toBe("{ broken");
  });

  it("keeps every host key when the volume lost its files, whatever the baseline holds", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a", defaultModel: "p/a" });
    await env.writeHost("pi-style.json", { style: "terse" });

    await env.sync();

    await rm(join(env.guestAgentDir, "settings.json"));
    await rm(join(env.guestAgentDir, "pi-style.json"));

    expect(await env.sync()).toEqual({ changes: [], notices: [] });
    expect(await env.host("settings.json")).toEqual({ theme: "a", defaultModel: "p/a" });
    expect(await env.host("pi-style.json")).toEqual({ style: "terse" });
    expect(await env.volume("pi-style.json")).toEqual({ style: "terse" });
  });

  it("drops a settings.json value of the wrong type and writes the valid ones", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { enabledModels: ["p/a"], theme: "dark" });

    await env.sync();

    await env.writeVolume("settings.json", {
      enabledModels: [1],
      theme: "../../../tmp/evil",
      quietStartup: true,
    });

    expect(await env.sync()).toEqual({
      changes: ["settings.json quietStartup: (unset) → true written to the host"],
      notices: [
        "settings.json: enabledModels in the sandbox is not a valid value; not written back",
        "settings.json: theme in the sandbox is not a valid value; not written back",
      ],
    });
    expect(await env.host("settings.json")).toEqual({
      enabledModels: ["p/a"],
      theme: "dark",
      quietStartup: true,
    });
  });

  it("skips a volume file that is not a regular file instead of opening it", async () => {
    const env = await setup();

    await env.writeHost("pi-style.json", { style: "a" });

    await env.sync();

    await env.guestShell('rm "$1" && mkfifo "$1"', "pi-style.json");

    const result = await env.sync();

    expect(result.notices).toEqual([
      "warning: pi-style.json was not written back: pi-style.json: it is not a regular file in the sandbox volume",
    ]);
    expect(await env.host("pi-style.json")).toEqual({ style: "a" });
  });

  it("gives up on a volume read that does not finish and treats the file as unreadable", async () => {
    const env = await setup();

    await env.writeHost("pi-style.json", { style: "a" });

    await env.sync();

    await env.writeVolume("pi-style.json", { style: "b" });

    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) =>
      spec.command.some((part) => part.startsWith("[ -f")) &&
      spec.command.some((part) => part.endsWith("pi-style.json"))
        ? new Promise<number>(() => undefined)
        : exec(spec, io);

    const result = await env.sync(50);

    expect(result.notices).toEqual([
      "warning: pi-style.json was not written back: pi-style.json: could not read it from the sandbox volume: the command in the sandbox did not finish within 50 ms",
    ]);
    expect(await env.host("pi-style.json")).toEqual({ style: "a" });
  });

  it("keeps the baseline when a sync into a container that is gone fails, so another launch still writes back", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    await env.writeVolume("settings.json", { theme: "b" });

    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) => (spec.command[0] === "sh" ? Promise.resolve(1) : exec(spec, io));

    const ended = await env.sync();

    env.fake.backend.exec = exec;

    const otherLaunch = await env.sync();

    expect(ended.changes).toEqual([]);
    expect(ended.notices).toContain(
      "warning: the sandbox copies of the agent settings were not refreshed: settings.json: could not write it into the sandbox volume (exit 1)",
    );
    expect(ended.notices.join("\n")).not.toContain("will not be written back to the host");
    expect(otherLaunch.changes).toEqual(["settings.json theme: a → b written to the host"]);
    expect(await env.host("settings.json")).toEqual({ theme: "b" });
    expect(await env.volume("settings.json")).toEqual({ theme: "b" });
  });

  it("advances the kept baseline past what that failed sync wrote back, so a later host change is not undone", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    await env.writeVolume("settings.json", { theme: "b" });

    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) =>
      spec.command.some((part) => part.startsWith("mkdir -p")) ? Promise.resolve(1) : exec(spec, io);

    const failed = await env.sync();

    env.fake.backend.exec = exec;

    await env.writeHost("settings.json", { theme: "a" });

    const next = await env.sync();

    expect(failed.changes).toEqual(["settings.json theme: a → b written to the host"]);
    expect(next.changes).toEqual([]);
    expect(await env.host("settings.json")).toEqual({ theme: "a" });
    expect(await env.volume("settings.json")).toEqual({ theme: "a" });
  });

  it("drops the baseline of a file whose copy may have landed, and names it", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) =>
      spec.command.some((part) => part.startsWith("mkdir -p")) &&
      spec.command.some((part) => part.endsWith("/settings.json"))
        ? Promise.reject(new Error("the connection broke"))
        : exec(spec, io);

    const result = await env.sync();

    env.fake.backend.exec = exec;

    expect(result.notices).toEqual([
      "warning: the sandbox copies of the agent settings were not refreshed: the connection broke",
      "warning: preference changes made in the sandbox to settings.json from now on will not be written back to the host",
    ]);

    const record = await env.baseline();

    expect(Object.keys((record?.files ?? {}) as object)).not.toContain("settings.json");
    expect(Object.keys((record?.files ?? {}) as object)).toContain("pi-style.json");
    expect(record?.copied).toEqual([
      "pi-subagents.json",
      "pi-style.json",
      "pi-notifications.json",
      "pi-session-limits.json",
      "pi-prune.json",
    ]);

    await env.writeVolume("settings.json", { theme: "b" });

    expect((await env.sync()).changes).toEqual([]);
    expect(await env.host("settings.json")).toEqual({ theme: "a" });
  });

  it("says that later changes will not be written back when no file's copy can be trusted", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) =>
      spec.command.some((part) => part.startsWith("mkdir -p") || part === 'rm -f "$1"')
        ? Promise.resolve(137)
        : exec(spec, io);

    const result = await env.sync();

    expect(result.notices).toEqual([
      expect.stringMatching(/^warning: the sandbox copies of the agent settings were not refreshed: /),
      "warning: preference changes made in the sandbox from now on will not be written back to the host",
    ]);
  });

  it("writes through a symlinked host file and keeps the link", async () => {
    const env = await setup();
    const dotfiles = await tempDir("write-back-dotfiles");
    const target = join(dotfiles, "settings.json");

    await writeText(target, JSON.stringify({ theme: "a" }));

    await symlink(target, join(env.hostAgentDir, "settings.json"));

    await env.sync();

    await env.writeVolume("settings.json", { theme: "b" });

    await env.sync();

    expect((await lstat(join(env.hostAgentDir, "settings.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ theme: "b" });
  });

  it("reports a volume file that cannot be read and still syncs", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    await env.writeVolume("pi-style.json", { style: "b" });

    await chmod(join(env.guestAgentDir, "pi-style.json"), 0o000);

    const result = await env.sync();

    expect(result.notices).toEqual([
      expect.stringMatching(
        /^warning: pi-style\.json was not written back: pi-style\.json: could not read it/,
      ),
    ]);
    expect(await env.host("pi-style.json")).toBeUndefined();
    expect(await env.volume("settings.json")).toEqual({ theme: "a" });
  });

  it("writes a change once when two sessions share the volume", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    await env.writeVolume("settings.json", { theme: "b" });

    const secondLaunch = await env.sync();
    const firstExit = await env.sync();
    const secondExit = await env.sync();

    expect(secondLaunch.changes).toEqual(["settings.json theme: a → b written to the host"]);
    expect([...firstExit.changes, ...secondExit.changes]).toEqual([]);
    expect(await env.host("settings.json")).toEqual({ theme: "b" });
  });

  it("keeps one baseline for every folder, so a change made in one folder's session is written back once", async () => {
    const env = await setup();
    const otherRoot = await tempDir("write-back-other-repo");
    const syncOther = () =>
      syncVolumeFiles({
        backend: env.fake.backend,
        containerId: env.containerId,
        stateDir: env.stateDir,
        hostAgentDir: env.hostAgentDir,
        workspaceRoot: otherRoot,
        allowlist: BUILT_IN_WRITE_BACK,
      });

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    await env.writeVolume("settings.json", { theme: "b" });

    const otherLaunch = await syncOther();
    const firstExit = await env.sync();

    expect(otherLaunch.changes).toEqual(["settings.json theme: a → b written to the host"]);
    expect(firstExit.changes).toEqual([]);
    expect(await env.host("settings.json")).toEqual({ theme: "b" });
    expect(await env.baseline()).toBeDefined();
  });
});
