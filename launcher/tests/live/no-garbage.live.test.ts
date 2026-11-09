import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listContainers, listNetworks } from "./harness/engine.ts";
import { createLiveSandbox, type LiveSandbox, liveEnabled } from "./harness/sandbox.ts";
import { fixtureConfig } from "./harness/scenario.ts";

describe.skipIf(!liveEnabled)("the last session leaves nothing behind (live)", () => {
  const state: { sandbox?: LiveSandbox } = {};

  beforeAll(async () => {
    const sandbox = await createLiveSandbox("no-garbage");

    state.sandbox = sandbox;

    await sandbox.writeUserConfig(fixtureConfig(sandbox, { allow: ["example.test"] }));
  }, 120_000);

  afterAll(async () => {
    await state.sandbox?.cleanup();
  }, 120_000);

  it("removes the container, relay, network, proxy, launch entry and repository state when pi exits", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const network = `pi-sandbox-${sandbox.repoHash.slice(0, 12)}`;
    const first = await sandbox.pi(["--version"]).done;

    expect(first.code).toBe(0);

    const running = await listContainers({ "pi-sandbox.repo-hash": sandbox.repoHash });

    expect(running.map((container) => container.Labels["pi-sandbox.relay"] === "true").sort()).toEqual([
      false,
      true,
    ]);

    const last = await sandbox.lastExit();

    expect(last.code).toBe(0);

    expect(await listContainers({ "pi-sandbox.repo-hash": sandbox.repoHash })).toEqual([]);

    expect((await listNetworks()).map((candidate) => candidate.Name)).not.toContain(network);

    expect(await sandbox.leftovers()).toEqual([]);
  });
});
