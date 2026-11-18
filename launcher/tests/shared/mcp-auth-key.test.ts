import { readdir, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { readMcpLogins, stateLayout, updateMcpLogin, withMcpLoginDir } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const state = { dir: "" };

beforeEach(async () => {
  state.dir = await tempDir("mcp-login");
});

const KEYS = Array.from({ length: 4 }, (_, index) => `mcp__server_${index}|https://mcp${index}.test/`);

describe("updateMcpLogin", () => {
  it("keeps every server's entry when several servers write at once", async () => {
    await Promise.all(KEYS.map((key, index) => updateMcpLogin(state.dir, key, () => ({ lastStart: index }))));

    const logins = await readMcpLogins(state.dir);

    expect(Object.keys(logins).sort()).toEqual([...KEYS].sort());
    expect(JSON.parse(await readFile(stateLayout(state.dir).mcpLogin, "utf8"))[KEYS[3] ?? ""]).toEqual({
      lastStart: 3,
    });
  });
});

describe("withMcpLoginDir", () => {
  it("hands an empty folder under the state dir and removes it after use or failure", async () => {
    const seen: string[] = [];

    expect(
      await withMcpLoginDir(state.dir, async (cwd) => {
        seen.push(cwd);

        return readdir(cwd);
      }),
    ).toEqual([]);

    await expect(
      withMcpLoginDir(state.dir, async (cwd) => {
        seen.push(cwd);

        throw new Error("login failed");
      }),
    ).rejects.toThrow("login failed");

    expect(seen.every((cwd) => cwd.startsWith(stateLayout(state.dir).mcpLoginDirPrefix))).toBe(true);
    expect((await readdir(state.dir)).filter((name) => name.startsWith("mcp-login-"))).toEqual([]);
  });
});
