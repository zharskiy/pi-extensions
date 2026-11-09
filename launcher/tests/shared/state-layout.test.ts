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
    expect(layout.vmLock).toBe("/state/locks/vm.lock");
    expect(layout.gitPinLock("g1")).toBe("/state/locks/git-g1.lock");
    expect(layout.mcpLogin).toBe("/state/mcp-login.json");
    expect(layout.mcpLoginLock("mcp__docs|https://docs.test/")).toMatch(
      /^\/state\/locks\/mcp-login-[0-9a-f]{8}\.lock$/,
    );
    expect(layout.providerHosts("1.5.0")).toBe("/state/provider-hosts/1.5.0.json");
    expect(layout.gcRecord).toBe("/state/gc.json");
    expect(layout.ca).toBe("/state/ca");
    expect(layout.extraPem).toBe("/state/ca/extra.pem");
    expect(layout.imageRecord).toBe("/state/image.json");
  });

  it("keeps every file of one repository under repos/<repo hash>, its proxy included", () => {
    const { gitCopy, ...files } = stateLayout("/state").repo("r1");

    expect(files).toEqual({
      directory: "/state/repos/r1",
      record: "/state/repos/r1/repo.json",
      launches: "/state/repos/r1/launches",
      lock: "/state/repos/r1/lock",
      containerLock: "/state/repos/r1/container.lock",
      render: "/state/repos/r1/render",
      sync: "/state/repos/r1/sync",
      git: "/state/repos/r1/git",
      gitBaseline: "/state/repos/r1/git/baseline.json",
      pins: "/state/repos/r1/pins.json",
      created: "/state/repos/r1/created.json",
      proxy: {
        directory: "/state/repos/r1/proxy",
        record: "/state/repos/r1/proxy/proxy.json",
        token: "/state/repos/r1/proxy/token",
        log: "/state/repos/r1/proxy/proxy.log",
        accessLog: "/state/repos/r1/proxy/access.log",
      },
    });
    expect(gitCopy("/repo/.git/config")).toMatch(/^\/state\/repos\/r1\/git\/[0-9a-f]{16}$/);
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
