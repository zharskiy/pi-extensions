import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { syncVolumeFiles } from "../../provision/index.ts";
import { processMark, stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
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

  return { fake, containerId, volume };
};

describe("syncVolumeFiles for settings.json", () => {
  const setup = async (volume: Record<string, unknown>) => {
    const stateDir = await tempDir("sync-state");
    const repoRoot = await tempDir("sync-repo");
    const hostAgentDir = await tempDir("sync-host");
    const { fake, containerId, volume: volumeFile } = await volumeBackend(volume);
    const sync = async (hostSettings: Record<string, unknown>) => {
      await writeText(join(hostAgentDir, "settings.json"), JSON.stringify(hostSettings));

      return syncVolumeFiles({
        backend: fake.backend,
        containerId,
        stateDir,
        repoHash: "repo1",
        hostAgentDir,
        repoRoot,
      });
    };

    return { stateDir, repoRoot, hostAgentDir, fake, sync, volume: volumeFile };
  };

  it("replaces the volume copy with the filtered host copy on every launch", async () => {
    const env = await setup({ "settings.json": { theme: "dark", packages: ["npm:inside"], local: 1 } });
    const result = await env.sync({ theme: "light", packages: ["npm:a"] });

    expect(result.notices).toEqual([]);
    expect(await env.volume("settings.json")).toEqual({ theme: "light", packages: ["npm:a"] });

    const broken = await setup({ "settings.json": "{ broken" });

    await broken.sync({ theme: "dark" });

    expect(await broken.volume("settings.json")).toEqual({ theme: "dark" });
  });

  it("drops local packages outside the mounts with a notice and keeps mounted ones", async () => {
    const env = await setup({});
    const inRepo = join(env.repoRoot, "tools", "ext");
    const result = await env.sync({
      packages: ["/elsewhere/ext", inRepo, "npm:a", "~/private/ext"],
    });

    expect(await env.volume("settings.json")).toEqual({
      packages: [inRepo, "npm:a"],
    });
    expect(result.notices).toEqual([
      "settings.json: package /elsewhere/ext is a local path outside the sandbox mounts; skipped in the sandbox",
      "settings.json: package ~/private/ext is a local path outside the sandbox mounts; skipped in the sandbox",
    ]);
  });

  it("hands kept local packages to the sandbox as absolute host paths, file URLs included", async () => {
    const env = await setup({});
    const result = await env.sync({
      packages: [
        relative(env.hostAgentDir, join(env.repoRoot, "ext")),
        `file://${join(env.repoRoot, "tool")}`,
        { source: join(env.repoRoot, "y"), skills: [] },
        "file:///elsewhere/z",
      ],
    });

    expect(await env.volume("settings.json")).toEqual({
      packages: [
        join(env.repoRoot, "ext"),
        join(env.repoRoot, "tool"),
        { source: join(env.repoRoot, "y"), skills: [] },
      ],
    });
    expect(result.notices).toEqual([
      "settings.json: package file:///elsewhere/z is a local path outside the sandbox mounts; skipped in the sandbox",
    ]);
  });

  it("names resource paths in settings.json that lie outside the sandbox mounts", async () => {
    const env = await setup({});
    const result = await env.sync({
      extensions: ["/elsewhere/ext.ts", `${env.repoRoot}/x.ts`, "extensions/local.ts", "!/elsewhere/off.ts"],
      skills: [`${env.repoRoot}/skill`],
      themes: "not-a-list",
    });

    expect(result.notices).toEqual([
      "settings.json: extensions entry /elsewhere/ext.ts lies outside the sandbox mounts and is missing in the sandbox",
      "settings.json: extensions entry /elsewhere/off.ts lies outside the sandbox mounts and is missing in the sandbox",
    ]);
  });

  it("drops command and session dir settings, whatever the volume held", async () => {
    const planted = {
      npmCommand: ["sh", "-c", "planted"],
      selfUpdateCommand: ["planted"],
      shellPath: "/planted/sh",
      shellCommandPrefix: "planted;",
      externalEditor: "planted",
      httpProxy: "http://planted.example:1",
      sessionDir: "/planted/sessions",
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
    const lock = stateLayout(env.stateDir).repo("repo1").syncLock;

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
});
