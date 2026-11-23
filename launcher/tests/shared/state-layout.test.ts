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
    expect(layout.caKey).toBe("/state/ca/ca-key.pem");
    expect(layout.caCert).toBe("/state/ca/ca-cert.pem");
    expect(layout.replacedPiLink).toBe("/state/replaced-pi-link");
    expect(layout.extraPem).toBe("/state/ca/extra.pem");
    expect(layout.imageRecord).toBe("/state/image.json");
  });

  it("puts only the rendered files and the trust bundle under vm/, the one dir the VM shares", () => {
    const layout = stateLayout("/state");
    const inVm = (path: string) => path.startsWith("/state/vm/");
    const flat = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
          ? Object.values(value).flatMap(flat)
          : [];
    const hidden = [...flat(layout), ...flat(layout.repo("r1"))].filter(inVm);

    expect(layout.vm).toBe("/state/vm");
    expect(hidden.sort()).toEqual(["/state/vm/agent", "/state/vm/render", "/state/vm/render/r1"]);
  });

  it("keeps every file of one repository under repos/<repo hash>", () => {
    const files = stateLayout("/state").repo("r1");

    expect(files).toEqual({
      directory: "/state/repos/r1",
      record: "/state/repos/r1/repo.json",
      prepareLock: "/state/locks/prepare-r1.lock",
      created: "/state/repos/r1/created.json",
      legacy: {
        render: "/state/vm/render/r1",
        renderLock: "/state/repos/r1/render.lock",
        sync: "/state/repos/r1/sync",
      },
    });
  });

  it("keeps the rendered pi folder, its sync records and their locks once for the install", () => {
    const layout = stateLayout("/state");

    expect(layout.render).toBe("/state/vm/agent");
    expect(layout.renderLock).toBe("/state/locks/render.lock");
    expect(layout.agentLock).toBe("/state/locks/agent.lock");
    expect(layout.sync).toEqual({
      directory: "/state/sync",
      lock: "/state/locks/sync.lock",
      baseline: "/state/sync/baseline.json",
      packages: "/state/sync/packages.json",
      installFailed: "/state/sync/install-failed.json",
    });
  });

  it("keeps the proxy, the launch registry and the ground lock once for the install", () => {
    const layout = stateLayout("/state");

    expect(layout.launches).toBe("/state/launches");
    expect(layout.launchesLock).toBe("/state/locks/launches.lock");
    expect(layout.groundLock).toBe("/state/locks/ground.lock");
    expect(layout.proxy).toEqual({
      directory: "/state/proxy",
      record: "/state/proxy/proxy.json",
      token: "/state/proxy/token",
      log: "/state/proxy/proxy.log",
      rotatedLog: "/state/proxy/proxy.log.1",
      accessLog: "/state/proxy/access.log",
      rotatedAccessLog: "/state/proxy/access.log.1",
      egress: "/state/proxy/egress.json",
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
