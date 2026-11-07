import { readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { repoProxyToken, writeProxyDynamic } from "../../proxy/dynamic.ts";
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

const runtime = () =>
  createProxyRuntime({
    stateDir: state.stateDir,
    policyHash: POLICY_HASH,
    staticRules: [],
    grantsEnabled: false,
    cap: {},
  });

const launch = async (repoHash: string, id: string, vault = [vaultServer({ server: id })]) => {
  const token = await repoProxyToken(state.stateDir, POLICY_HASH, repoHash);

  await writeProxyDynamic(state.stateDir, POLICY_HASH, {
    version: 1,
    rules: [rule(id)],
    derivedHosts: [`${id}-host.test`],
    vault,
    tokens: { [sha256Hex(token)]: repoHash },
  });
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

    const stored = JSON.parse(
      await readFile(stateLayout(state.stateDir).proxyDynamic(POLICY_HASH), "utf8"),
    ) as {
      repos: Record<string, unknown>;
      rules: CredentialRule[];
    };

    expect(Object.keys(stored.repos)).toHaveLength(1);
    expect(ids(stored.rules)).toEqual(["beta"]);
  });

  it("shares a section written without a repository token with every repository", async () => {
    await writeProxyDynamic(state.stateDir, POLICY_HASH, {
      version: 1,
      rules: [rule("shared")],
      derivedHosts: [],
      tokens: {},
    });

    await launch(REPO_A, "alpha");

    expect(ids(await runtime().rules(REPO_A))).toEqual(["alpha", "shared"]);
    expect(ids(await runtime().rules(REPO_B))).toEqual(["shared"]);
  });
});
