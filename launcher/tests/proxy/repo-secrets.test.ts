import { rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoProxyToken } from "../../proxy/dynamic.ts";
import { createRepoSecrets } from "../../proxy/repo-secrets.ts";
import { createProxyRuntime } from "../../proxy/runtime.ts";
import { sha256Hex, stateLayout } from "../../shared/index.ts";
import { createStateDir, POLICY_HASH, removeDir } from "./harness.ts";

const REPO_A = "a".repeat(64);

const REPO_B = "b".repeat(64);

const state = { stateDir: "" };

beforeEach(async () => {
  state.stateDir = await createStateDir();
});

afterEach(async () => {
  await removeDir(state.stateDir);
});

const setup = () => {
  const runtime = createProxyRuntime({
    stateDir: state.stateDir,
    policyHash: POLICY_HASH,
    staticRules: [],
    grantsEnabled: false,
    cap: {},
  });

  return createRepoSecrets(runtime);
};

const tokenHashOf = async (repoHash: string) =>
  sha256Hex(await repoProxyToken(state.stateDir, POLICY_HASH, repoHash));

const message = (repoTokenHash: string | undefined, secrets: Record<string, string>) => ({
  type: "env-secrets" as const,
  secrets,
  ...(repoTokenHash === undefined ? {} : { repoTokenHash }),
});

describe("per-repository env secrets", () => {
  it("keeps each repository's secrets when another repository launches", async () => {
    const secrets = setup();

    await secrets.accept(message(await tokenHashOf(REPO_A), { rule: "from-a", parent: "corp:a" }));

    await secrets.accept(message(await tokenHashOf(REPO_B), { rule: "from-b" }));

    expect(Object.fromEntries(await secrets.secretsOf(REPO_A))).toEqual({ rule: "from-a", parent: "corp:a" });
    expect(Object.fromEntries(await secrets.secretsOf(REPO_B))).toEqual({ rule: "from-b" });
    expect((await secrets.secretsOf(undefined)).size).toBe(0);
  });

  it("replaces only the launching repository's entries", async () => {
    const secrets = setup();
    const hashA = await tokenHashOf(REPO_A);

    await secrets.accept(message(hashA, { rule: "old", gone: "x" }));

    await secrets.accept(message(await tokenHashOf(REPO_B), { rule: "from-b" }));

    await secrets.accept(message(hashA, { rule: "new" }));

    expect(Object.fromEntries(await secrets.secretsOf(REPO_A))).toEqual({ rule: "new" });
    expect(Object.fromEntries(await secrets.secretsOf(REPO_B))).toEqual({ rule: "from-b" });
  });

  it("refuses a message without a live repository token", async () => {
    const secrets = setup();

    expect(await secrets.accept(message(undefined, { rule: "x" }))).toMatchObject({ ok: false });
    expect(await secrets.accept(message("f".repeat(64), { rule: "x" }))).toMatchObject({ ok: false });
  });

  it("drops a repository's secrets once its token is gone", async () => {
    const secrets = setup();

    await secrets.accept(message(await tokenHashOf(REPO_A), { rule: "from-a" }));

    await rm(stateLayout(state.stateDir).proxyRepoToken(POLICY_HASH, REPO_A), { force: true });

    expect((await secrets.secretsOf(REPO_A)).size).toBe(0);
  });

  it("notices a removed token even when the tokens directory keeps its timestamp", async () => {
    const secrets = setup();
    const tokenFile = stateLayout(state.stateDir).proxyRepoToken(POLICY_HASH, REPO_A);

    await secrets.accept(message(await tokenHashOf(REPO_A), { rule: "from-a" }));

    const directory = dirname(tokenFile);
    const before = await stat(directory);

    await rm(tokenFile, { force: true });

    await utimes(directory, before.atimeMs / 1000, before.mtimeMs / 1000);

    expect((await secrets.secretsOf(REPO_A)).size).toBe(0);
  });
});
