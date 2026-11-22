import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installIdOf, LABELS, roleOf, SERVICES_ALIAS } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { FAKE_NETWORK } from "../support/fake-backend.ts";
import { createFakeBackend, createHarness, holdLaunch, renderDirOf } from "./harness.ts";

const SERVICES = [
  { name: "db", command: ["db", "--serve"], ready: { command: ["db-ready"] } },
  { name: "cache", command: ["cache"] },
];

describe("a launch with services", () => {
  it("starts the pod on the install network and the services before the agent, then stops them at the end", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, { services: SERVICES });

    expect(await run([], harness.deps)).toBe(0);

    const roles = fake.created.map((entry) => roleOf(entry.summary.labels));
    const pod = fake.created[0];
    const agent = fake.created.find((entry) => roleOf(entry.summary.labels) === "agent");
    const graceful = fake.stops.filter((stop) => stop.timeoutSeconds === 30);

    expect(roles).toEqual(["pod", "service", "service", "agent"]);
    expect(pod?.summary.name).toBe(`pi-sandbox-pod-${installIdOf(harness.stateDir)}`);
    expect(pod?.summary.labels[LABELS.repoHash]).toBeUndefined();
    expect(pod?.spec?.network).toEqual({ kind: "internal", name: FAKE_NETWORK, alias: SERVICES_ALIAS });
    expect(agent?.spec?.network).toEqual({ kind: "internal", name: FAKE_NETWORK });
    expect(harness.stderr()).toContain("pi-sandbox: starting service db");
    expect(graceful.map((stop) => stop.id).sort()).toEqual(
      [fake.created[1]?.summary.id, fake.created[2]?.summary.id].sort(),
    );
    expect([...fake.containers.values()].map((entry) => roleOf(entry.summary.labels))).toEqual([]);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
  });

  it("keeps the services running while another pi session of this install is live", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await holdLaunch(harness);

    await harness.writeJson(harness.userConfigFile, { services: SERVICES });

    expect(await run([], harness.deps)).toBe(0);

    const left = [...fake.containers.values()].map((entry) => roleOf(entry.summary.labels)).sort();

    expect(left).toEqual(["pod", "service", "service"]);
  });

  it("hands the agent the ports of every service for its forwarder", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const services = [
      { ...SERVICES[0], ports: [5432] },
      { ...SERVICES[1], ports: [6379, 6380] },
    ];

    await harness.writeJson(harness.userConfigFile, { services });

    await run([], harness.deps);

    const agent = fake.created.find((entry) => roleOf(entry.summary.labels) === "agent");

    expect(agent?.spec?.env.PI_SANDBOX_SERVICE_PORTS).toBe("5432 6379 6380");
    expect(agent?.spec?.env.PI_SANDBOX_SERVICES_HOST).toBe(SERVICES_ALIAS);
  });

  it("tells the agent the services and their ports in the status file", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      services: [{ ...SERVICES[0], ports: [5432] }, SERVICES[1]],
    });

    await run([], harness.deps);

    const status = JSON.parse(await readFile(join(renderDirOf(harness), "tools", "status.json"), "utf8"));

    expect(status.services).toEqual([
      { name: "db", command: ["db", "--serve"], ready: ["db-ready"], ports: [5432] },
      { name: "cache", command: ["cache"], ports: [] },
    ]);
  });

  it("lists the install services and their state in pi sandbox status", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, { services: SERVICES });

    const db = fake.addContainer({
      name: "pi-sandbox-service-db",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.role]: "service",
        [LABELS.serviceName]: "db",
      },
      state: "running",
      image: "x",
    });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("services: 2");
    expect(lines).toContain(`service: db running (${db})`);
    expect(lines).toContain("service: cache not started");
  });

  it("starts only the agent, on the internal network, without services", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    expect(fake.created.map((entry) => roleOf(entry.summary.labels))).toEqual(["agent"]);
    expect(fake.created[0]?.spec?.network.kind).toBe("internal");
  });
});
