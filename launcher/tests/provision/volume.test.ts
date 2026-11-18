import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCapture } from "../../backend/index.ts";
import { readVolumeFile } from "../../provision/index.ts";
import { GUEST_PATHS } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir } from "./fixtures.ts";

const setup = async () => {
  const fake = createFakeBackend({ guestAgentDir: await tempDir("volume-read") });
  const containerId = await runningContainer(fake.backend);
  const read = (name: string, timeoutMs?: number) =>
    readVolumeFile(fake.backend, containerId, name, timeoutMs);
  const guestShell = (script: string, name: string) =>
    execCapture(fake.backend, {
      containerId,
      command: ["sh", "-c", script, "sh", join(GUEST_PATHS.agentDir, name)],
      env: {},
      workdir: "/",
    });

  return { fake, read, guestShell };
};

describe("readVolumeFile", () => {
  it("reads a JSON object, and a missing file as no value", async () => {
    const env = await setup();

    await env.fake.writeGuestFile("settings.json", JSON.stringify({ theme: "a" }));

    expect(await env.read("settings.json")).toEqual({ value: { theme: "a" }, invalid: false });
    expect(await env.read("mcp-auth.json")).toEqual({ invalid: false });
  });

  it("reads an empty or whitespace-only file as no value", async () => {
    const env = await setup();

    await env.fake.writeGuestFile("settings.json", "");

    await env.fake.writeGuestFile("mcp-auth.json", " \n\t");

    expect(await env.read("settings.json")).toEqual({ invalid: false });
    expect(await env.read("mcp-auth.json")).toEqual({ invalid: false });
  });

  it("reports a file that is not a JSON object as invalid", async () => {
    const env = await setup();

    await env.fake.writeGuestFile("settings.json", "[1]");

    expect(await env.read("settings.json")).toEqual({ invalid: true });
  });

  it("reports a file larger than 1 MiB as invalid", async () => {
    const env = await setup();

    await env.fake.writeGuestFile("settings.json", JSON.stringify({ theme: "a".repeat(1024 * 1024) }));

    expect(await env.read("settings.json")).toEqual({ invalid: true });
  });

  it("refuses a FIFO without opening it", async () => {
    const env = await setup();

    await env.guestShell('mkfifo "$1"', "mcp-auth.json");

    await expect(env.read("mcp-auth.json")).rejects.toThrow("mcp-auth.json: it is not a regular file");
  });

  it("gives up on a read that does not finish", async () => {
    const env = await setup();
    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) =>
      spec.command.some((part) => part.endsWith("settings.json"))
        ? new Promise<number>(() => undefined)
        : exec(spec, io);

    await expect(env.read("settings.json", 50)).rejects.toThrow("settings.json: could not read it");
  });
});
