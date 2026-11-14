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

  it("reports a file that is not a JSON object as invalid", async () => {
    const env = await setup();

    await env.fake.writeGuestFile("settings.json", "[1]");

    expect(await env.read("settings.json")).toEqual({ invalid: true });
  });

  it("reports a FIFO as invalid without opening it", async () => {
    const env = await setup();

    await env.guestShell('mkfifo "$1"', "mcp-auth.json");

    expect(await env.read("mcp-auth.json")).toEqual({ invalid: true });
  });

  it("reports a read that does not finish as invalid", async () => {
    const env = await setup();
    const exec = env.fake.backend.exec;

    env.fake.backend.exec = (spec, io) =>
      spec.command.some((part) => part.endsWith("settings.json"))
        ? new Promise<number>(() => undefined)
        : exec(spec, io);

    expect(await env.read("settings.json", 50)).toEqual({ invalid: true });
  });
});
