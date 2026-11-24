import { describe, expect, it } from "vitest";
import { installIdOf, LABELS, networkName, relayName } from "../../backend/index.ts";
import { run, runPinata } from "../../cli/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createFakeBackend, createHarness, holdLaunch, sweepNow } from "./harness.ts";

type Fake = ReturnType<typeof createFakeBackend>;

const twoInstalls = async (fake: Fake) => {
  const ids = new Map<string, string>();
  const a = await createHarness({ backend: () => fake.backendFor(ids.get("a") ?? "") });
  const b = await createHarness({ backend: () => fake.backendFor(ids.get("b") ?? "") });

  ids.set("a", installIdOf(a.stateDir));

  ids.set("b", installIdOf(b.stateDir));

  return { a, b, idA: installIdOf(a.stateDir), idB: installIdOf(b.stateDir) };
};

const plantSession = (fake: Fake, install: string, repoRoot: string) =>
  fake.addContainer({
    name: `pi-sandbox-${install}`,
    labels: {
      [LABELS.managed]: "true",
      [LABELS.install]: install,
      [LABELS.role]: "agent",
      [LABELS.repoHash]: sha256Hex(repoRoot),
    },
    state: "running",
    image: "x",
  });

const plantGround = async (fake: Fake, install: string) => {
  await fake
    .backendFor(install)
    .prepareRelay({ hostPort: 4100, imageId: "relay", preamble: `PI-SANDBOX ${install}` });

  return fake.addContainer({
    name: `pi-sandbox-pod-${install}`,
    labels: { [LABELS.managed]: "true", [LABELS.install]: install, [LABELS.role]: "pod" },
    state: "running",
    image: "x",
  });
};

describe("two installs on one engine", () => {
  it("brings up and tears down the second install's ground without touching the first one's", async () => {
    const fake = createFakeBackend();
    const { a, b, idA, idB } = await twoInstalls(fake);
    const pod = await plantGround(fake, idA);
    const relay = fake.relays.get(relayName(idA));

    await holdLaunch(a);

    expect(await run([], b.deps)).toBe(0);
    expect(fake.created.some((entry) => entry.summary.labels[LABELS.install] === idB)).toBe(true);
    expect(fake.routes.some((route) => route.preamble !== `PI-SANDBOX ${idA}`)).toBe(true);
    expect(fake.networks.has(networkName(idB))).toBe(false);
    expect(fake.relays.has(relayName(idB))).toBe(false);
    expect(fake.networks.has(networkName(idA))).toBe(true);
    expect(fake.relays.get(relayName(idA))).toEqual(relay);
    expect(fake.containers.has(pod)).toBe(true);
  });

  it("keeps the first install's live session when the second install's last session ends", async () => {
    const fake = createFakeBackend();
    const { a, b, idA } = await twoInstalls(fake);
    const session = plantSession(fake, idA, a.repoRoot);

    await plantGround(fake, idA);

    await holdLaunch(a);

    expect(await run([], b.deps)).toBe(0);
    expect(fake.containers.has(session)).toBe(true);
    expect(fake.networks.has(networkName(idA))).toBe(true);
    expect(fake.relays.has(relayName(idA))).toBe(true);
  });

  it("sweeps only its own leftovers, not the other install's session of the same folder", async () => {
    const fake = createFakeBackend();
    const { a, idA, idB } = await twoInstalls(fake);
    const own = plantSession(fake, idA, a.repoRoot);
    const other = plantSession(fake, idB, a.repoRoot);

    await sweepNow(a.deps);

    expect(fake.containers.has(own)).toBe(false);
    expect(fake.containers.has(other)).toBe(true);
  });

  it("counts the sessions of both installs before it stops the VM", async () => {
    const busy: number[] = [];
    const fake = createFakeBackend({
      vm: {
        stop: async (options) => {
          busy.push((await options.busy()).count);

          return "stopped";
        },
      },
    });
    const { a, b, idA, idB } = await twoInstalls(fake);

    plantSession(fake, idA, a.repoRoot);

    plantSession(fake, idB, b.repoRoot);

    await holdLaunch(a);

    expect(await runPinata(["stop"], a.deps)).toBe(0);
    expect(busy).toEqual([2]);
  });
});
