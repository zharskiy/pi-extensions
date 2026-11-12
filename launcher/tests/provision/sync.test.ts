import { chmod, lstat, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCapture } from "../../backend/index.ts";
import { syncVolumeFiles } from "../../provision/index.ts";
import { GUEST_PATHS, readJsonObject, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir, writeText } from "./fixtures.ts";

const setup = async () => {
  const stateDir = await tempDir("write-back-state");
  const repoRoot = await tempDir("write-back-repo");
  const hostAgentDir = await tempDir("write-back-host");
  const guestAgentDir = await tempDir("write-back-volume");
  const fake = createFakeBackend({ guestAgentDir });
  const containerId = await runningContainer(fake.backend);
  const sync = (readTimeoutMs?: number) =>
    syncVolumeFiles({
      backend: fake.backend,
      containerId,
      stateDir,
      repoHash: "repo1",
      hostAgentDir,
      repoRoot,
      readTimeoutMs,
    });
  const host = async (name: string) => readJsonObject(join(hostAgentDir, name));
  const volume = async (name: string) => {
    const text = await fake.guestFile(name);

    return text === undefined ? undefined : JSON.parse(text);
  };
  const writeHost = (name: string, value: unknown) =>
    writeText(join(hostAgentDir, name), JSON.stringify(value));
  const writeVolume = (name: string, value: unknown) =>
    fake.writeGuestFile(name, typeof value === "string" ? value : JSON.stringify(value));
  const baseline = () => readJsonObject(stateLayout(stateDir).repo("repo1").syncBaseline);

  const guestShell = (script: string, name: string) =>
    execCapture(fake.backend, {
      containerId,
      command: ["sh", "-c", script, "sh", join(GUEST_PATHS.agentDir, name)],
      env: {},
      workdir: "/",
    });

  return {
    hostAgentDir,
    guestAgentDir,
    fake,
    sync,
    host,
    volume,
    writeHost,
    writeVolume,
    baseline,
    guestShell,
  };
};

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

  it("says that later changes will not be written back when refreshing the volume fails", async () => {
    const env = await setup();

    await env.writeHost("settings.json", { theme: "a" });

    await env.sync();

    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) =>
      spec.command.some((part) => part.startsWith("mkdir -p")) ? Promise.resolve(1) : exec(spec, io);

    const result = await env.sync();

    expect(result.notices).toEqual([
      expect.stringMatching(/^warning: the sandbox copies of the agent settings were not refreshed: /),
      "warning: preference changes made in the sandbox from now on will not be written back to the host",
    ]);
    expect(await env.baseline()).toBeUndefined();
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
});
