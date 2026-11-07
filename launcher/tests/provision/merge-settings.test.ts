import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeTopLevel,
  packageChangeFor,
  readVolumeSettings,
  syncWritableFiles,
} from "../../provision/index.ts";
import { GUEST_PATHS, stateLayout } from "../../shared/index.ts";
import { createFakeBackend, type FakeExec, stdinOf } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir, writeText } from "./fixtures.ts";

const BAKED = "/opt/pi-sandbox/extensions/node_modules/pi-extensions-mz";

const guest = (name: string) => `${GUEST_PATHS.agentDir}/${name}`;

const volumeBackend = (files: Record<string, unknown>) =>
  createFakeBackend({
    execScripts: Object.entries(files).map(([name, value]) => ({
      command: ["cat", guest(name)],
      stdout: typeof value === "string" ? value : JSON.stringify(value),
    })),
  });

const writes = (execs: FakeExec[]) =>
  Object.fromEntries(
    execs
      .filter((exec) => exec.spec.command[0] === "sh")
      .map((exec) => [exec.spec.command.at(-1), JSON.parse(stdinOf(exec).toString("utf8"))]),
  );

describe("mergeTopLevel", () => {
  it("lets host-changed keys win, keeps volume-only keys and applies host deletions", () => {
    const base = { theme: "dark", packages: ["npm:a"], removed: 1, same: "x" };
    const host = { theme: "light", packages: ["npm:a"], same: "x", added: true };
    const volume = { theme: "dark", packages: ["npm:a", "npm:inside"], removed: 1, same: "y", volumeOnly: 2 };

    expect(mergeTopLevel(base, host, volume)).toEqual({
      theme: "light",
      packages: ["npm:a", "npm:inside"],
      same: "y",
      volumeOnly: 2,
      added: true,
    });
  });

  it("takes every host key on the first sync and the host copy when the volume has none", () => {
    expect(mergeTopLevel(undefined, { a: 1 }, { a: 2, b: 3 })).toEqual({ a: 1, b: 3 });
    expect(mergeTopLevel({ a: 1 }, { a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("syncWritableFiles", () => {
  const setup = async (volume: Record<string, unknown>) => {
    const stateDir = await tempDir("sync-state");
    const repoRoot = await tempDir("sync-repo");
    const fake = volumeBackend(volume);
    const sync = (hostSettings: Record<string, unknown> | undefined, mcp: Record<string, unknown> = {}) =>
      syncWritableFiles({
        backend: fake.backend,
        containerId: "c1",
        stateDir,
        repoHash: "repo1",
        hostAgentDir: "/host/.pi/agent",
        repoRoot,
        config: sandboxConfig({ mounts: { extraReadOnly: ["/shared/libs"], cacheVolumes: [] } }),
        hostSettings,
        mcp,
      });

    return { stateDir, repoRoot, fake, sync };
  };

  it("writes merged settings and mcp files through stdin and records the host copies", async () => {
    const env = await setup({ "settings.json": { packages: [BAKED], inside: true } });
    const mcp = { mcpServers: { docs: { url: "https://docs.example/mcp" } } };
    const result = await env.sync({ theme: "dark" }, mcp);
    const syncDir = stateLayout(env.stateDir).sync("repo1");

    expect(result.notices).toEqual([]);
    expect(writes(env.fake.execs)).toEqual({
      [guest("settings.json")]: { packages: [BAKED], inside: true, theme: "dark" },
      [guest("mcp.json")]: mcp,
    });
    expect(JSON.parse(await readFile(join(syncDir, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    expect(JSON.parse(await readFile(join(syncDir, "mcp.json"), "utf8"))).toEqual(mcp);
  });

  it("does not write a file that is already up to date", async () => {
    const env = await setup({ "settings.json": { theme: "dark" }, "mcp.json": { mcpServers: {} } });

    await env.sync({ theme: "dark" }, { mcpServers: {} });

    expect(writes(env.fake.execs)).toEqual({});
  });

  it("drops local packages outside the mounts with a notice and keeps mounted ones", async () => {
    const env = await setup({});
    const inRepo = join(env.repoRoot, "tools", "ext");
    const result = await env.sync({
      packages: ["/elsewhere/ext", inRepo, "/shared/libs/x", "npm:a", "~/private/ext"],
    });

    expect(writes(env.fake.execs)[guest("settings.json")]).toEqual({
      packages: [inRepo, "/shared/libs/x", "npm:a"],
    });
    expect(result.notices).toEqual([
      "settings.json: package /elsewhere/ext is a local path outside the sandbox mounts; skipped in the sandbox",
      "settings.json: package ~/private/ext is a local path outside the sandbox mounts; skipped in the sandbox",
    ]);
  });

  it("dedupes the baked extensions package against a host npm entry and keeps it when the host changes packages", async () => {
    const env = await setup({ "settings.json": { packages: [BAKED] } });

    await env.sync({ packages: ["npm:pi-extensions-mz@1.2.3", "npm:other"] });

    expect(writes(env.fake.execs)[guest("settings.json")]).toEqual({ packages: [BAKED, "npm:other"] });

    const other = await setup({ "settings.json": { packages: [BAKED] } });

    await other.sync({ packages: ["npm:other"] });

    expect(writes(other.fake.execs)[guest("settings.json")]).toEqual({ packages: [BAKED, "npm:other"] });
  });

  it("keeps command and proxy settings from the host and drops the ones the volume planted", async () => {
    const planted = {
      npmCommand: ["sh", "-c", "planted"],
      selfUpdateCommand: ["planted"],
      shellPath: "/planted/sh",
      shellCommandPrefix: "planted;",
      externalEditor: "planted",
      httpProxy: "http://planted.example:1",
      theme: "volume",
    };
    const env = await setup({ "settings.json": planted });

    await writeText(
      join(stateLayout(env.stateDir).sync("repo1"), "settings.json"),
      JSON.stringify({ shellPath: "/bin/zsh" }),
    );

    await env.sync({ shellPath: "/bin/zsh" });

    expect(writes(env.fake.execs)[guest("settings.json")]).toEqual({
      theme: "volume",
      shellPath: "/bin/zsh",
    });
  });

  it("applies host deletions against the last synced copy", async () => {
    const env = await setup({ "settings.json": { theme: "dark", local: 1 } });

    await writeText(
      join(stateLayout(env.stateDir).sync("repo1"), "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );

    await env.sync({});

    expect(writes(env.fake.execs)[guest("settings.json")]).toEqual({ local: 1 });
  });

  it("removes a credential from a package URL inside the sandbox and in the base copy, with a notice", async () => {
    const env = await setup({});
    const result = await env.sync({
      packages: [
        "git:https://me:ghp_token123@github.com/org/ext",
        { source: "https://TOKEN456@git.example.com/org/tool.git", skills: [] },
        "git:git@github.com:org/plain",
        "npm:a",
      ],
    });
    const syncDir = stateLayout(env.stateDir).sync("repo1");
    const base = await readFile(join(syncDir, "settings.json"), "utf8");

    expect(writes(env.fake.execs)[guest("settings.json")]).toEqual({
      packages: [
        "git:https://github.com/org/ext",
        { source: "https://git.example.com/org/tool.git", skills: [] },
        "git:git@github.com:org/plain",
        "npm:a",
      ],
    });
    expect(base).not.toMatch(/ghp_token123|TOKEN456/);
    expect(result.notices).toEqual([
      "settings.json package github.com carried a credential in its URL; it was removed inside the sandbox",
      "settings.json package git.example.com carried a credential in its URL; it was removed inside the sandbox",
    ]);
  });

  it("writes the base copies readable by the owner only", async () => {
    const env = await setup({});

    await env.sync({ theme: "dark" }, { mcpServers: {} });

    const syncDir = stateLayout(env.stateDir).sync("repo1");

    expect((await stat(join(syncDir, "settings.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(syncDir, "mcp.json"))).mode & 0o777).toBe(0o600);
  });

  it("waits for another launch's sync of the same repository before it reads the volume", async () => {
    const env = await setup({});
    const lock = join(stateLayout(env.stateDir).sync("repo1"), "sync.lock");

    await mkdir(lock, { recursive: true });

    const pending = env.sync({ theme: "dark" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(env.fake.execs).toEqual([]);

    await rm(lock, { recursive: true });

    await pending;

    expect(writes(env.fake.execs)[guest("settings.json")]).toEqual({ theme: "dark" });
  });

  it("replaces an invalid volume file with a notice", async () => {
    const env = await setup({ "settings.json": "{ broken" });
    const result = await env.sync({ theme: "dark" });

    expect(writes(env.fake.execs)[guest("settings.json")]).toEqual({ theme: "dark" });
    expect(result.notices).toEqual([
      "settings.json in the sandbox volume was not valid JSON; replaced with the host copy",
    ]);
  });
});

describe("readVolumeSettings and packageChangeFor", () => {
  it("reads the volume settings and reports undefined when the file is missing", async () => {
    const present = volumeBackend({ "settings.json": { packages: ["npm:a"] } });
    const missing = createFakeBackend({ execScripts: [{ command: ["cat"], code: 1 }] });

    expect(await readVolumeSettings(present.backend, "c1")).toEqual({ packages: ["npm:a"] });
    expect(await readVolumeSettings(missing.backend, "c1")).toBeUndefined();
  });

  it("reports an install only when the sandbox recorded the exact source asked for", () => {
    const install = (source: string) => ({ kind: "install" as const, source });

    expect(packageChangeFor({ packages: [] }, { packages: ["npm:tool"] }, install("npm:tool"))).toEqual({
      kind: "install",
    });
    expect(
      packageChangeFor(
        { packages: ["npm:tool@1.0.0"] },
        { packages: [{ source: "npm:tool@2.0.0", skills: [] }] },
        install("npm:tool@2.0.0"),
      ),
    ).toEqual({ kind: "install" });
    expect(
      packageChangeFor(
        { packages: [] },
        { packages: ["npm:tool@git+https://attacker.example/x.git"] },
        install("npm:tool"),
      ),
    ).toEqual({ kind: "mismatch", recorded: "npm:tool@git+https://attacker.example/x.git" });
    expect(
      packageChangeFor({ packages: ["npm:x"] }, { packages: ["npm:x"] }, install("npm:x")),
    ).toBeUndefined();
    expect(
      packageChangeFor({ packages: ["npm:tool@9"] }, { packages: ["npm:tool@9"] }, install("npm:tool")),
    ).toEqual({ kind: "mismatch", recorded: "npm:tool@9" });
    expect(packageChangeFor({ packages: ["npm:x"] }, { packages: [] }, install("npm:x"))).toBeUndefined();
    expect(packageChangeFor(undefined, undefined, install("npm:x"))).toBeUndefined();
  });

  it("reports a removal only when an entry for the source existed before and none remains", () => {
    const remove = { kind: "remove" as const, source: "npm:tool" };

    expect(
      packageChangeFor({ packages: ["npm:tool@1.0.0", "npm:x"] }, { packages: ["npm:x"] }, remove),
    ).toEqual({
      kind: "remove",
    });
    expect(packageChangeFor({ packages: ["npm:x"] }, { packages: ["npm:x"] }, remove)).toBeUndefined();
    expect(packageChangeFor({ packages: ["npm:tool"] }, { packages: ["npm:tool"] }, remove)).toBeUndefined();
  });
});
