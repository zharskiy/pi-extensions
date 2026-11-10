import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncSettingsFile } from "../../provision/index.ts";
import { processMark, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { runningContainer, tempDir, writeText } from "./fixtures.ts";

const volumeText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

const volumeBackend = async (files: Record<string, unknown>) => {
  const guestAgentDir = await tempDir("sync-volume");

  await Promise.all(
    Object.entries(files).map(([name, value]) => writeText(join(guestAgentDir, name), volumeText(value))),
  );

  const fake = createFakeBackend({ guestAgentDir });
  const containerId = await runningContainer(fake.backend);
  const volume = async (name: string) => {
    const text = await fake.guestFile(name);

    return text === undefined ? undefined : JSON.parse(text);
  };

  const changedAt = async (name: string) => (await stat(join(guestAgentDir, name))).mtimeMs;

  return { fake, containerId, volume, changedAt };
};

describe("syncSettingsFile", () => {
  const setup = async (volume: Record<string, unknown>) => {
    const stateDir = await tempDir("sync-state");
    const repoRoot = await tempDir("sync-repo");
    const { fake, containerId, volume: volumeFile, changedAt } = await volumeBackend(volume);
    const sync = (hostSettings: Record<string, unknown> | undefined) =>
      syncSettingsFile({
        backend: fake.backend,
        containerId,
        stateDir,
        repoHash: "repo1",
        hostAgentDir: "/host/.pi/agent",
        repoRoot,
        config: sandboxConfig({ mounts: { extraReadOnly: ["/shared/libs"], cacheVolumes: [] } }),
        hostSettings,
      });

    return { stateDir, repoRoot, fake, sync, volume: volumeFile, changedAt };
  };

  it("overwrites the volume keys the host sets and keeps the volume-only keys", async () => {
    const env = await setup({ "settings.json": { theme: "dark", packages: ["npm:inside"], local: 1 } });
    const result = await env.sync({ theme: "light", packages: ["npm:a"] });

    expect(result.notices).toEqual([]);
    expect(await env.volume("settings.json")).toEqual({ theme: "light", packages: ["npm:a"], local: 1 });
  });

  it("writes the host copy when the volume has none and leaves an up to date file alone", async () => {
    const fresh = await setup({});

    await fresh.sync({ theme: "dark" });

    expect(await fresh.volume("settings.json")).toEqual({ theme: "dark" });

    const current = await setup({ "settings.json": { theme: "dark" } });
    const before = await current.changedAt("settings.json");

    await current.sync({ theme: "dark" });

    expect(await current.changedAt("settings.json")).toBe(before);
  });

  it("drops local packages outside the mounts with a notice and keeps mounted ones", async () => {
    const env = await setup({});
    const inRepo = join(env.repoRoot, "tools", "ext");
    const result = await env.sync({
      packages: ["/elsewhere/ext", inRepo, "/shared/libs/x", "npm:a", "~/private/ext"],
    });

    expect(await env.volume("settings.json")).toEqual({
      packages: [inRepo, "/shared/libs/x", "npm:a"],
    });
    expect(result.notices).toEqual([
      "settings.json: package /elsewhere/ext is a local path outside the sandbox mounts; skipped in the sandbox",
      "settings.json: package ~/private/ext is a local path outside the sandbox mounts; skipped in the sandbox",
    ]);
  });

  it("drops command and session dir settings from both the host and the volume", async () => {
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

    await env.sync({
      shellPath: "/opt/homebrew/bin/bash",
      npmCommand: ["/opt/homebrew/bin/npm"],
      externalEditor: "code --wait",
      sessionDir: "/Users/me/pi-sessions",
      theme: "host",
    });

    expect(await env.volume("settings.json")).toEqual({ theme: "host" });
  });

  it("never syncs the host httpProxy, which may carry the proxy password", async () => {
    const env = await setup({});

    await env.sync({ httpProxy: "http://corp:PROXY-REAL-PW@proxy.corp.test:3128", theme: "dark" });

    expect(await env.volume("settings.json")).toEqual({ theme: "dark" });
    expect(await env.fake.guestFile("settings.json")).not.toContain("PROXY-REAL-PW");
  });

  it("removes a credential from a package URL inside the sandbox, with a notice", async () => {
    const env = await setup({});
    const result = await env.sync({
      packages: [
        "git:https://me:ghp_token123@github.com/org/ext",
        { source: "https://TOKEN456@git.example.com/org/tool.git", skills: [] },
        "git:git@github.com:org/plain",
        "npm:a",
      ],
    });

    expect(await env.volume("settings.json")).toEqual({
      packages: [
        "git:https://github.com/org/ext",
        { source: "https://git.example.com/org/tool.git", skills: [] },
        "git:git@github.com:org/plain",
        "npm:a",
      ],
    });
    expect(result.notices).toEqual([
      "settings.json package github.com carried a credential in its URL; it was removed inside the sandbox",
      "settings.json package git.example.com carried a credential in its URL; it was removed inside the sandbox",
    ]);
  });

  it("waits for another launch's sync of the same repository before it reads the volume", async () => {
    const env = await setup({});
    const lock = join(stateLayout(env.stateDir).repo("repo1").sync, "sync.lock");

    await mkdir(dirname(lock), { recursive: true });

    const self = await processMark();

    await writeFile(lock, `${self.pid} ${self.boot} ${self.start} 0123456789abcdef`);

    const pending = env.sync({ theme: "dark" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(env.fake.execs).toEqual([]);

    await rm(lock);

    await pending;

    expect(await env.volume("settings.json")).toEqual({ theme: "dark" });
  });

  it("replaces an invalid volume file with a notice", async () => {
    const env = await setup({ "settings.json": "{ broken" });
    const result = await env.sync({ theme: "dark" });

    expect(await env.volume("settings.json")).toEqual({ theme: "dark" });
    expect(result.notices).toEqual([
      "settings.json in the sandbox volume was not valid JSON; replaced with the host copy",
    ]);
  });
});
