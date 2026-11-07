import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSalt, isAuthLikeHeader, stateLayout } from "../../shared/index.ts";

const state = { dir: "" };

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-state-"));
});

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true });
});

describe("ensureSalt", () => {
  it("creates a 64 hex salt with mode 600 and returns the same one afterwards", async () => {
    const stateDir = join(state.dir, "nested");
    const salt = await ensureSalt(stateDir);

    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(await ensureSalt(stateDir)).toBe(salt);
    expect((await stat(join(stateDir, "salt"))).mode & 0o777).toBe(0o600);
  });

  it("gives concurrent callers the same salt", async () => {
    const salts = await Promise.all([1, 2, 3, 4].map(() => ensureSalt(state.dir)));

    expect(new Set(salts).size).toBe(1);
  });

  it("replaces a salt file that is not a valid salt", async () => {
    await writeFile(join(state.dir, "salt"), "short");

    const salt = await ensureSalt(state.dir);

    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(state.dir, "salt"), "utf8")).toBe(salt);
  });
});

describe("stateLayout", () => {
  it("places every state file under the state dir", () => {
    const layout = stateLayout("/state");

    expect(layout.salt).toBe("/state/salt");
    expect(layout.grants).toBe("/state/grants.json");
    expect(layout.render("r1")).toBe("/state/render/r1");
    expect(layout.sync("r1")).toBe("/state/sync/r1");
    expect(layout.sessionsOf("r1")).toBe("/state/sessions/r1");
    expect(layout.mcpAuthServer("docs")).toBe("/state/mcp-auth/servers/docs.json");
    expect(layout.providerHosts("1.5.0")).toBe("/state/provider-hosts/1.5.0.json");
    expect(layout.proxyDynamic("p1")).toBe("/state/proxy/p1/dynamic.json");
    expect(layout.proxyRepoToken("p1", "r1")).toBe("/state/proxy/p1/tokens/r1");
  });
});

describe("isAuthLikeHeader", () => {
  it("covers authorization and secret-looking names but not the proxy credential", () => {
    expect(isAuthLikeHeader("Authorization")).toBe(true);
    expect(isAuthLikeHeader("x-api-key")).toBe(true);
    expect(isAuthLikeHeader("X-Auth-Token")).toBe(true);
    expect(isAuthLikeHeader("proxy-authorization")).toBe(false);
    expect(isAuthLikeHeader("content-type")).toBe(false);
  });
});
