import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installIdOf, networkName } from "../../backend/index.ts";
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

  it("removes each launch's container when its pi exits, and the relay, network, proxy and state after the last", async () => {
    const sandbox = state.sandbox as LiveSandbox;
    const first = await sandbox.pi(["list"]).done;

    expect(first.code).toBe(0);

    const relays = await listContainers({
      "pinata.role": "relay",
      "pinata.install": installIdOf(sandbox.stateDir),
    });

    expect(await listContainers({ "pinata.repo-hash": sandbox.repoHash })).toEqual([]);
    expect(relays.map((container) => container.Labels["pinata.repo-hash"])).toEqual([undefined]);

    const last = await sandbox.lastExit();

    expect(last.code).toBe(0);

    expect(await listContainers({ "pinata.repo-hash": sandbox.repoHash })).toEqual([]);

    expect((await listNetworks()).map((candidate) => candidate.Name)).not.toContain(
      networkName(installIdOf(sandbox.stateDir)),
    );
    expect(
      await listContainers({
        "pinata.role": "relay",
        "pinata.install": installIdOf(sandbox.stateDir),
      }),
    ).toEqual([]);

    expect(await sandbox.leftovers()).toEqual([]);
  });
});
