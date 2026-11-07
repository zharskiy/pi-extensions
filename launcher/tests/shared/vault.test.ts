import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codePlaceholder,
  isCodePlaceholder,
  isPlaceholder,
  loadVaultStore,
  readVaultStore,
  stateLayout,
  syntheticExpiresIn,
  type VaultEntry,
  vaultPlaceholders,
  writeVaultEntry,
} from "../../shared/index.ts";

const state = { dir: "" };

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-vault-"));
});

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true });
});

const entry = (access: string): VaultEntry => ({
  serverUrl: "https://mcp.example.test/mcp",
  tokens: { access_token: access, token_type: "Bearer" },
});

describe("vault placeholders", () => {
  it("are stable per server, distinct per role and recognised as placeholders", () => {
    const first = vaultPlaceholders("salt", "docs");
    const values = Object.values(first);

    expect(vaultPlaceholders("salt", "docs")).toEqual(first);

    expect(new Set(values).size).toBe(3);

    expect(values.every(isPlaceholder)).toBe(true);

    expect(vaultPlaceholders("salt", "other").access).not.toBe(first.access);
  });

  it("mints a fresh code placeholder each time in its own format", () => {
    const code = codePlaceholder();

    expect(code).toMatch(/^pi-sandbox-code-[0-9a-f]{32}$/);

    expect(codePlaceholder()).not.toBe(code);

    expect(isPlaceholder(code)).toBe(true);

    expect(isCodePlaceholder(code)).toBe(true);

    expect(isCodePlaceholder(vaultPlaceholders("salt", "docs").access)).toBe(false);
  });
});

describe("syntheticExpiresIn", () => {
  it("caps at an hour and never goes below five minutes", () => {
    expect(syntheticExpiresIn(86_400)).toBe(3600);

    expect(syntheticExpiresIn(1200.7)).toBe(1200);

    expect(syntheticExpiresIn(10)).toBe(300);

    expect(syntheticExpiresIn(-5)).toBe(300);
  });
});

describe("vault store", () => {
  it("reads an absent or broken store as empty", async () => {
    expect(await readVaultStore(state.dir)).toEqual({});

    await writeVaultEntry(state.dir, "seed", entry("a"));

    await writeFile(stateLayout(state.dir).mcpAuthStore, "not json");

    expect(await readVaultStore(state.dir)).toEqual({});
  });

  it("writes, replaces and removes one key with mode 600 and keeps the others", async () => {
    const path = stateLayout(state.dir).mcpAuthStore;

    await writeFile(join(state.dir, "unused"), "");

    await writeVaultEntry(state.dir, "mcp__docs|https://mcp.example.test/mcp", entry("first"));

    await writeVaultEntry(state.dir, "mcp__other|https://other.example.test/", entry("other"));

    await writeVaultEntry(state.dir, "mcp__docs|https://mcp.example.test/mcp", entry("second"));

    expect(await readVaultStore(state.dir)).toEqual({
      "mcp__docs|https://mcp.example.test/mcp": entry("second"),
      "mcp__other|https://other.example.test/": entry("other"),
    });

    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await writeVaultEntry(state.dir, "mcp__docs|https://mcp.example.test/mcp", null);

    expect(Object.keys(JSON.parse(await readFile(path, "utf8")) as object)).toEqual([
      "mcp__other|https://other.example.test/",
    ]);
  });

  it("loses no key when many writers update the store at once", async () => {
    const keys = ["a", "b", "c", "d", "e", "f"];

    await Promise.all(keys.map((key) => writeVaultEntry(state.dir, key, entry(key))));

    expect(Object.keys(await readVaultStore(state.dir)).sort()).toEqual(keys);
  });

  it("drops entries that are not objects", async () => {
    await writeVaultEntry(state.dir, "kept", entry("kept"));

    const path = stateLayout(state.dir).mcpAuthStore;
    const store = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    await writeFile(path, JSON.stringify({ ...store, broken: "text", list: [] }));

    expect(Object.keys(await readVaultStore(state.dir))).toEqual(["kept"]);
  });
});

describe("a corrupt vault store", () => {
  const corrupt = async () => {
    const path = stateLayout(state.dir).mcpAuthStore;

    await mkdir(join(state.dir, "mcp-auth"), { recursive: true });

    await writeFile(path, "{ not json");

    return path;
  };

  it("reads as empty without moving the file", async () => {
    const path = await corrupt();

    expect(await readVaultStore(state.dir)).toEqual({});
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("is moved aside once before the first write, which starts a fresh store", async () => {
    const path = await corrupt();

    await writeVaultEntry(state.dir, "first", entry("one"));

    await writeVaultEntry(state.dir, "second", entry("two"));

    const names = await readdir(join(state.dir, "mcp-auth"));
    const aside = names.filter((name) => name.startsWith("mcp-auth.json.corrupt-"));

    expect(aside).toHaveLength(1);
    expect(await readFile(join(state.dir, "mcp-auth", aside[0] ?? ""), "utf8")).toBe("{ not json");
    expect(Object.keys(await loadVaultStore(path, { forWrite: false }))).toEqual(["first", "second"]);
  });
});
