import { lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../index.ts";
import { isolateAgentDir, prepareAgentDir, restoreAgentDir } from "../pi/live/index.ts";

const tempDirs = useTempDirs();

const tempDir = () => tempDirs.make("pi-live-agent-dir-");

describe("prepareAgentDir", () => {
  it("links auth.json to the real file and copies models.json", () => {
    const real = tempDir();
    const temp = tempDir();

    writeFileSync(join(real, "auth.json"), '{"a":1}');
    writeFileSync(join(real, "models.json"), '{"m":1}');
    writeFileSync(join(real, "AGENTS.md"), "context");

    prepareAgentDir(real, temp);

    expect(lstatSync(join(temp, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(temp, "auth.json"))).toBe(join(real, "auth.json"));
    expect(lstatSync(join(temp, "models.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(temp, "models.json"), "utf8")).toBe('{"m":1}');
    expect(() => lstatSync(join(temp, "AGENTS.md"))).toThrow();
  });

  it("writes a refreshed token through to the real auth file", () => {
    const real = tempDir();
    const temp = tempDir();

    writeFileSync(join(real, "auth.json"), '{"token":"old"}');

    prepareAgentDir(real, temp);
    writeFileSync(join(temp, "auth.json"), '{"token":"new"}');
    rmSync(temp, { recursive: true, force: true });

    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe('{"token":"new"}');
  });

  it("skips files the real agent dir does not have", () => {
    const real = tempDir();
    const temp = tempDir();

    prepareAgentDir(real, temp);

    expect(() => lstatSync(join(temp, "auth.json"))).toThrow();
    expect(() => lstatSync(join(temp, "models.json"))).toThrow();
  });
});

describe("isolateAgentDir", () => {
  it("points PI_CODING_AGENT_DIR at the temp dir, leaves the real auth file alone and restores the variable", () => {
    const real = tempDir();
    const agentDir = tempDir();
    const before = process.env.PI_CODING_AGENT_DIR;

    writeFileSync(join(real, "auth.json"), '{"a":1}');

    isolateAgentDir(real, agentDir);

    expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
    expect(lstatSync(join(agentDir, "auth.json")).isSymbolicLink()).toBe(true);

    restoreAgentDir();

    expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
    expect(readFileSync(join(real, "auth.json"), "utf8")).toBe('{"a":1}');
  });

  it("deletes the variable on restore when it was unset", () => {
    const before = process.env.PI_CODING_AGENT_DIR;

    delete process.env.PI_CODING_AGENT_DIR;
    isolateAgentDir(tempDir(), tempDir());
    restoreAgentDir();

    expect("PI_CODING_AGENT_DIR" in process.env).toBe(false);

    if (before !== undefined) {
      process.env.PI_CODING_AGENT_DIR = before;
    }
  });
});
