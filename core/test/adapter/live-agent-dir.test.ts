import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentDir } from "./live.ts";

const dirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-live-agent-dir-"));

  dirs.push(dir);

  return dir;
};

afterEach(() => {
  dirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

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
