import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureSalt, isAuthLikeHeader, stateLayout } from "../../shared/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const state = { dir: "" };

beforeEach(async () => {
  state.dir = await tempDir("state");
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
    expect(layout.grantsLock).toBe("/state/grants.json.lock");
    expect(layout.vmLock).toBe("/state/locks/vm.lock");
    expect(layout.mcpLogin).toBe("/state/mcp-login.json");
    expect(layout.mcpLoginLock("mcp__docs|https://docs.test/")).toMatch(
      /^\/state\/locks\/mcp-login-[0-9a-f]{8}\.lock$/,
    );
    expect(layout.providerHosts("1.5.0")).toBe("/state/provider-hosts/1.5.0.json");
    expect(layout.gcRecord).toBe("/state/gc.json");
    expect(layout.ca).toBe("/state/ca");
    expect(layout.caLock).toBe("/state/ca/ca.lock");
    expect(layout.extraPem).toBe("/state/ca/extra.pem");
    expect(layout.imageRecord).toBe("/state/image.json");
  });

  it("keeps every file of one repository under repos/<repo hash>, its proxy included", () => {
    const files = stateLayout("/state").repo("r1");

    expect(files).toEqual({
      directory: "/state/repos/r1",
      record: "/state/repos/r1/repo.json",
      launches: "/state/repos/r1/launches",
      lock: "/state/repos/r1/lock",
      containerLock: "/state/repos/r1/container.lock",
      render: "/state/repos/r1/render",
      renderLock: "/state/repos/r1/render.lock",
      sync: "/state/repos/r1/sync",
      syncLock: "/state/repos/r1/sync/sync.lock",
      syncBaseline: "/state/repos/r1/sync/baseline.json",
      gitBaseline: "/state/repos/r1/git/baseline.json",
      created: "/state/repos/r1/created.json",
      seen: "/state/repos/r1/seen.json",
      proxy: {
        directory: "/state/repos/r1/proxy",
        record: "/state/repos/r1/proxy/proxy.json",
        token: "/state/repos/r1/proxy/token",
        log: "/state/repos/r1/proxy/proxy.log",
        accessLog: "/state/repos/r1/proxy/access.log",
        egress: "/state/repos/r1/proxy/egress.json",
      },
    });
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
