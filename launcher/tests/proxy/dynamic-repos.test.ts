import { readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { addGrant } from "../../grants/index.ts";
import { removeRepoToken, repoProxyToken, writeProxyDynamic } from "../../proxy/dynamic.ts";
import { createProxyRuntime } from "../../proxy/runtime.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { createStateDir, POLICY_HASH, removeDir } from "./harness.ts";
import { vaultServer } from "./vault-fixture.ts";

const REPO_A = "a".repeat(64);

const REPO_B = "b".repeat(64);

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await createStateDir();
});

afterEach(async () => {
  await removeDir(state.stateDir);
});

const rule = (id: string): CredentialRule => ({
  id,
  host: `${id}.test`,
  placeholder: id,
  secret: { env: id },
});

const runtime = (extra: { grantsEnabled?: boolean } = {}) =>
  createProxyRuntime({
    stateDir: state.stateDir,
    policyHash: POLICY_HASH,
    staticRules: [],
    grantsEnabled: false,
    ...extra,
  });

const launch = async (repoHash: string, id: string, vault = [vaultServer({ server: id })]) => {
  const token = await repoProxyToken(state.stateDir, POLICY_HASH, repoHash);

  await writeProxyDynamic(state.stateDir, POLICY_HASH, {
    version: 1,
    rules: [rule(id)],
    derivedHosts: [`${id}-host.test`],
    vault,
    tokenHash: sha256Hex(token),
  });

  return token;
};

const ids = (rules: CredentialRule[]) => rules.map((entry) => entry.id).sort();

describe("dynamic configuration per repository", () => {
  it("keeps each repository's rules and vault servers apart and unions derived hosts", async () => {
    await launch(REPO_A, "alpha");

    await launch(REPO_B, "beta");

    const current = runtime();

    expect(ids(await current.rules(REPO_A))).toEqual(["alpha"]);
    expect(ids(await current.rules(REPO_B))).toEqual(["beta"]);
    expect((await current.vault(REPO_A)).map((server) => server.server)).toEqual(["alpha"]);
    expect(await current.extras(REPO_A)).toEqual(
      expect.arrayContaining(["alpha-host.test", "beta-host.test"]),
    );
  });

  it("replaces only the launching repository's entries", async () => {
    await launch(REPO_A, "alpha");

    await launch(REPO_B, "beta");

    await launch(REPO_A, "gamma", []);

    const current = runtime();

    expect(ids(await current.rules(REPO_A))).toEqual(["gamma"]);
    expect(await current.vault(REPO_A)).toEqual([]);
    expect(ids(await current.rules(REPO_B))).toEqual(["beta"]);
  });

  it("drops a repository's entries once its token is gone", async () => {
    await launch(REPO_A, "alpha");

    await rm(stateLayout(state.stateDir).proxyRepoToken(POLICY_HASH, REPO_A), { force: true });

    await launch(REPO_B, "beta");

    const current = runtime();
    const stored = JSON.parse(
      await readFile(stateLayout(state.stateDir).proxyDynamic(POLICY_HASH), "utf8"),
    ) as { repos: Record<string, unknown> };

    expect(Object.keys(stored.repos)).toHaveLength(1);
    expect(ids(await current.rules(REPO_A))).toEqual([]);
    expect(ids(await current.rules())).toEqual(["beta"]);
  });

  it("shares a section written without a repository token with every repository", async () => {
    await writeProxyDynamic(state.stateDir, POLICY_HASH, {
      version: 1,
      rules: [rule("shared")],
      derivedHosts: [],
    });

    await launch(REPO_A, "alpha");

    expect(ids(await runtime().rules(REPO_A))).toEqual(["alpha", "shared"]);
    expect(ids(await runtime().rules(REPO_B))).toEqual(["shared"]);
  });

  it("keeps every repository when many launches write at once", async () => {
    const repos = Array.from({ length: 12 }, (_unused, index) => index.toString(16).padStart(64, "0"));

    await Promise.all(repos.map((repo, index) => launch(repo, `repo${index}`)));

    const current = runtime();
    const found = await Promise.all(repos.map(async (repo) => ids(await current.rules(repo))));

    expect(found).toEqual(repos.map((_repo, index) => [`repo${index}`]));
  });
});

describe("repository tokens", () => {
  it("stop authenticating once gc removes the token file", async () => {
    const token = await launch(REPO_A, "alpha");
    const current = runtime();

    expect(await current.repoOf(token)).toBe(REPO_A);

    await removeRepoToken(state.stateDir, POLICY_HASH, REPO_A);

    expect(await current.repoOf(token)).toBeUndefined();
    expect(await current.liveRepos()).toEqual(new Set());
    expect(ids(await current.rules(REPO_A))).toEqual([]);
  });

  it("are stable for a repository and distinct between repositories", async () => {
    const first = await repoProxyToken(state.stateDir, POLICY_HASH, REPO_A);

    expect(await repoProxyToken(state.stateDir, POLICY_HASH, REPO_A)).toBe(first);
    expect(await repoProxyToken(state.stateDir, POLICY_HASH, REPO_B)).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("grants", () => {
  it("reach the runtime of the granted repository only, and nothing while grants are off", async () => {
    await addGrant(state.stateDir, { host: "granted.test", port: 443, repoHash: REPO_A }, true, Date.now());

    expect(await runtime({ grantsEnabled: true }).extras(REPO_A)).toContain("granted.test");
    expect(await runtime({ grantsEnabled: true }).extras(REPO_B)).not.toContain("granted.test");
    expect(await runtime().extras(REPO_A)).not.toContain("granted.test");
  });
});
