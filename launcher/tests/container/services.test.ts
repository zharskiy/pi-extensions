import { describe, expect, it } from "vitest";
import { type ContainerSummary, installIdOf, LABELS, roleOf, SERVICES_ALIAS } from "../../backend/index.ts";
import type { ServiceEntry } from "../../config/index.ts";
import {
  ensureServices,
  installServices,
  type ServicesInput,
  serviceVolumes,
  stopServices,
} from "../../container/index.ts";
import { ROOT_EXEC_ENV } from "../../container/lifecycle.ts";
import { configVolumeName } from "../../container/names.ts";
import { decide } from "../../container/services.ts";
import { createFakeBackend, FAKE_INSTALL, FAKE_NETWORK } from "../support/fake-backend.ts";

const STATE = "/state";

const DIGEST = `sha256:${"e".repeat(64)}`;

type Fake = ReturnType<typeof createFakeBackend>;

const db: ServiceEntry = {
  name: "db",
  command: ["db", "--serve"],
  user: "70:70",
  env: { DB_MODE: "local" },
  volumes: [{ name: "dbdata", target: "/var/lib/db" }],
  tmpfs: ["/run/db"],
  ready: { command: ["db-ready"], timeoutSeconds: 5 },
  memoryGiB: 1,
};

const cache: ServiceEntry = { name: "cache", command: ["cache"] };

const inputOf = (fake: Fake, fields: Partial<ServicesInput> = {}) => {
  const lines: string[] = [];
  const input: ServicesInput = {
    backend: fake.backend,
    stateDir: STATE,
    services: [db, cache],
    image: "sha256:sandbox",
    othersLive: async () => false,
    report: (line) => lines.push(line),
    ...fields,
  };

  return { input, lines };
};

const live = (fake: Fake) =>
  [...fake.containers.values()]
    .map((entry) => entry.summary)
    .filter((summary) => summary.state === "running");

const ofRole = (fake: Fake, role: string) =>
  [...fake.containers.values()].filter((entry) => roleOf(entry.summary.labels) === role);

const problemOf = async (pending: Promise<unknown>) => {
  try {
    await pending;

    return undefined;
  } catch (error) {
    return error as Error & { hint?: string };
  }
};

const dbVolume = configVolumeName(STATE, "dbdata");

const podOf = (fake: Fake) => ofRole(fake, "pod")[0]?.summary.id;

const started = async (fake: Fake, fields: Partial<ServicesInput> = {}) => {
  await ensureServices(inputOf(fake, fields).input);

  return podOf(fake);
};

describe("ensureServices", () => {
  it("starts one pod for the install on its own network, then the services in order, each joined to the pod and confined", async () => {
    const fake = createFakeBackend();
    const { input, lines } = inputOf(fake);

    await ensureServices(input);

    const [podEntry, dbEntry, cacheEntry] = fake.created;
    const pod = podOf(fake);

    expect(lines).toEqual(["pinata: starting service db", "pinata: starting service cache"]);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(true);
    expect(podEntry?.spec).toMatchObject({
      name: `pi-sandbox-pod-${installIdOf(STATE)}`,
      network: { kind: "internal", name: FAKE_NETWORK, alias: SERVICES_ALIAS },
      readOnlyRoot: true,
      init: true,
      autoRemove: false,
      entrypoint: ["sleep", "infinity"],
      mounts: [{ kind: "volume", source: dbVolume }],
      labels: { [LABELS.role]: "pod" },
    });
    expect(podEntry?.spec?.labels[LABELS.repoHash]).toBeUndefined();
    expect(podEntry?.spec?.labels[LABELS.servicesHash]).toMatch(/^[0-9a-f]{64}$/);
    expect(dbEntry?.spec).toMatchObject({
      name: `pi-sandbox-service-${installIdOf(STATE)}-db`,
      image: "sha256:sandbox",
      network: { kind: "container", id: pod },
      entrypoint: ["db", "--serve"],
      user: "70:70",
      env: { DB_MODE: "local" },
      mounts: [{ kind: "volume", source: dbVolume, target: "/var/lib/db" }],
      tmpfs: ["/tmp:mode=1777", "/run/db:mode=1777"],
      capabilities: [],
      readOnlyRoot: true,
      init: true,
      autoRemove: false,
      resources: { pids: 4096, memoryGiB: 1 },
      labels: { [LABELS.role]: "service", [LABELS.serviceName]: "db" },
    });
    expect(cacheEntry?.spec).toMatchObject({ user: "1000:1000", env: {}, tmpfs: ["/tmp:mode=1777"] });
    expect(dbEntry?.spec?.labels[LABELS.repoHash]).toBeUndefined();
    expect(fake.volumes.has(dbVolume)).toBe(true);
    expect(fake.volumeLabels.get(dbVolume)).toEqual({
      [LABELS.managed]: "true",
      [LABELS.install]: FAKE_INSTALL,
    });
  });

  it("hands each volume root to its service's user from the pod and checks readiness as that user", async () => {
    const fake = createFakeBackend();
    const pod = await started(fake);
    const chown = fake.execs.find((exec) => exec.spec.containerId === pod);
    const ready = fake.execs.find((exec) => exec.spec.command[0] === "db-ready");

    expect(chown?.spec).toMatchObject({
      user: "0",
      command: ["/bin/sh", "-c", '/bin/chown -h 70:70 "$@"', "sh", `/pi-sandbox/service-volumes/${dbVolume}`],
    });
    expect(chown?.spec.env).toEqual(ROOT_EXEC_ENV);
    expect(ready?.spec.user).toBe("70:70");
    expect(ready?.tty).toBe(false);
  });

  it("pulls a service image other than the sandbox image", async () => {
    const fake = createFakeBackend({ registry: { "registry.test/db:1": DIGEST } });
    const { input } = inputOf(fake, { services: [{ ...db, image: "registry.test/db:1" }] });

    await ensureServices(input);

    expect(fake.pulls).toEqual(["registry.test/db:1"]);
    expect(ofRole(fake, "service")[0]?.spec?.image).not.toBe("sha256:sandbox");
  });

  it("keeps a running pod and its services when the services are unchanged", async () => {
    const fake = createFakeBackend();
    const first = await started(fake);
    const { input, lines } = inputOf(fake);

    await ensureServices(input);

    expect(podOf(fake)).toBe(first);
    expect(fake.created).toHaveLength(3);
    expect(lines).toEqual([]);
  });

  it("recreates only a service that exited", async () => {
    const fake = createFakeBackend();
    const pod = await started(fake);
    const crashed = ofRole(fake, "service").find(
      (entry) => entry.summary.labels[LABELS.serviceName] === "cache",
    );

    await fake.backend.stopContainer(crashed?.summary.id ?? "");

    const { input, lines } = inputOf(fake);

    await ensureServices(input);

    expect(podOf(fake)).toBe(pod);
    expect(lines).toEqual(["pinata: starting service cache"]);
    expect(fake.removals).toEqual([crashed?.summary.id]);
    expect(live(fake)).toHaveLength(3);
  });

  it("checks the readiness of a running service again", async () => {
    const fake = createFakeBackend();

    await started(fake);

    fake.execs.length = 0;

    await ensureServices(inputOf(fake).input);

    expect(fake.execs.map((exec) => exec.spec.command)).toEqual([["db-ready"]]);
  });

  it("fails with the service's name when a running service is no longer ready", async () => {
    const health = { ready: true };
    const fake = createFakeBackend({
      exec: (spec) => (spec.command[0] === "db-ready" && !health.ready ? 1 : undefined),
    });
    const services = [{ ...db, ready: { command: ["db-ready"], timeoutSeconds: 1 } }, cache];

    await started(fake, { services });

    health.ready = false;

    const { input } = inputOf(fake, { services, othersLive: async () => true });

    expect((await problemOf(ensureServices(input)))?.message).toBe("service db was not ready within 1 s");
  });

  it("keeps the running services and says so when they changed while another session uses them", async () => {
    const fake = createFakeBackend();
    const pod = await started(fake);
    const { input, lines } = inputOf(fake, { services: [db], othersLive: async () => true });

    await ensureServices(input);

    expect(podOf(fake)).toBe(pod);
    expect(lines).toEqual([
      "pinata: the services in the config changed; they restart once every pi session has ended",
    ]);
    expect(live(fake)).toHaveLength(3);
  });

  it("stops everything and starts afresh when the services changed and no other session is live", async () => {
    const fake = createFakeBackend();
    const old = await started(fake);
    const pod = await started(fake, { services: [db] });

    expect(pod).not.toBe(old);
    expect(live(fake).map((summary) => roleOf(summary.labels))).toEqual(["pod", "service"]);
  });

  it("names a service that exits before it is ready, with its last log lines", async () => {
    const fake = createFakeBackend();
    const failing = { ...db, command: ["sh", "-c", "echo listening failed; exit 3"] };
    const { input } = inputOf(fake, { services: [failing, cache] });
    const error = await problemOf(ensureServices(input));

    expect(error?.message).toBe("service db exited with code 3 before it was ready\nlistening failed");
    expect(error?.hint).toBe("check services[0] in the config");
    expect(fake.containers.size).toBe(0);
  });

  it("gives up on a service that is not ready in time, with its log tail, and cleans up", async () => {
    const fake = createFakeBackend({
      exec: (spec) => {
        const entry = fake.containers.get(spec.containerId);

        if (spec.command[0] !== "db-ready" || entry === undefined) {
          return undefined;
        }

        fake.containers.set(spec.containerId, { ...entry, logs: ["waiting for disk\n"] });

        return 1;
      },
    });
    const { input } = inputOf(fake, {
      services: [{ ...db, ready: { command: ["db-ready"], timeoutSeconds: 1 } }],
    });
    const error = await problemOf(ensureServices(input));

    expect(error?.message).toBe("service db was not ready within 1 s\nwaiting for disk");
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(dbVolume)).toBe(true);
  });

  it("leaves the services up after a failure while another session uses them", async () => {
    const fake = createFakeBackend();
    const failing = { ...cache, command: ["sh", "-c", "exit 1"] };
    const { input } = inputOf(fake, { services: [db, failing], othersLive: async () => true });

    expect((await problemOf(ensureServices(input)))?.message).toBe(
      "service cache exited with code 1 before it was ready",
    );
    expect(live(fake).map((summary) => roleOf(summary.labels))).toEqual(["pod", "service"]);
  });

  it("stops waiting and cleans up when the launch is cancelled", async () => {
    const cancel = new AbortController();
    const fake = createFakeBackend({
      exec: (spec) => {
        if (spec.command[0] !== "db-ready") {
          return undefined;
        }

        cancel.abort(new Error("cancelled"));

        return 1;
      },
    });
    const { input } = inputOf(fake, { signal: cancel.signal });
    const error = await problemOf(ensureServices(input));

    expect(error?.message).toBe("cancelled");
    expect(fake.containers.size).toBe(0);
  });
});

describe("changed services while another session uses them", () => {
  it("starts a kept service that stopped", async () => {
    const fake = createFakeBackend();

    await started(fake);

    const crashed = ofRole(fake, "service").find(
      (entry) => entry.summary.labels[LABELS.serviceName] === "cache",
    );

    await fake.backend.stopContainer(crashed?.summary.id ?? "");

    const { input, lines } = inputOf(fake, { services: [db], othersLive: async () => true });

    await ensureServices(input);

    expect(lines).toEqual([
      "pinata: the services in the config changed; they restart once every pi session has ended",
      "pinata: starting service cache",
    ]);
    expect(live(fake)).toHaveLength(3);
  });

  it("fails with the name of a kept service that cannot start", async () => {
    const fake = createFakeBackend();

    await started(fake);

    const crashed = ofRole(fake, "service").find(
      (entry) => entry.summary.labels[LABELS.serviceName] === "cache",
    );

    await fake.backend.stopContainer(crashed?.summary.id ?? "");

    fake.backend.startContainer = async () => {
      throw new Error("no such image");
    };

    const { input } = inputOf(fake, { services: [db], othersLive: async () => true });

    expect((await problemOf(ensureServices(input)))?.message).toBe(
      "service cache is stopped and could not be started",
    );
    expect(live(fake)).toHaveLength(2);
  });
});

describe("decide", () => {
  const pod = (hash: string): ContainerSummary => ({
    id: "pod",
    name: "pod",
    image: "sha256:sandbox",
    state: "running",
    labels: { [LABELS.servicesHash]: hash },
  });

  it("refreshes the services of a pod with the same services", () => {
    expect(decide(pod("h1"), "h1", true)).toBe("refresh");
    expect(decide(pod("h1"), "h1", false)).toBe("refresh");
  });

  it("keeps a changed pod while another session is live and replaces it otherwise", () => {
    expect(decide(pod("h0"), "h1", true)).toBe("keep");
    expect(decide(pod("h0"), "h1", false)).toBe("fresh");
  });
});

describe("stopServices", () => {
  it("stops the services with 30 s each, then removes the pod, and keeps the volumes", async () => {
    const fake = createFakeBackend();
    const pod = await started(fake);
    const ids = ofRole(fake, "service").map((entry) => entry.summary.id);

    await stopServices(fake.backend);

    expect(fake.stops.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { id: ids[0], timeoutSeconds: 30 },
        { id: ids[1], timeoutSeconds: 30 },
      ]),
    );
    expect(fake.stops.slice(2)).toEqual([{ id: pod, timeoutSeconds: 3 }]);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(dbVolume)).toBe(true);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(true);
  });

  it("stops every service of the install at once, so the grace periods do not add up", async () => {
    const fake = createFakeBackend();
    const stopContainer = fake.backend.stopContainer.bind(fake.backend);
    const inFlight = { now: 0, most: 0 };

    await ensureServices(inputOf(fake).input);

    fake.backend.stopContainer = async (id, seconds) => {
      inFlight.now += 1;
      inFlight.most = Math.max(inFlight.most, inFlight.now);

      await new Promise((resolve) => setTimeout(resolve, 10));

      inFlight.now -= 1;

      return stopContainer(id, seconds);
    };

    await stopServices(fake.backend);

    expect(inFlight.most).toBe(2);
  });

  it("leaves the agent and relay containers alone", async () => {
    const fake = createFakeBackend();
    const agent = fake.addContainer({
      name: "agent",
      image: "sha256:sandbox",
      state: "running",
      labels: { [LABELS.managed]: "true", [LABELS.role]: "agent" },
    });

    await started(fake);

    expect((await installServices(fake.backend)).map((entry) => roleOf(entry.labels)).sort()).toEqual([
      "pod",
      "service",
      "service",
    ]);

    await stopServices(fake.backend);

    expect([...fake.containers.keys()]).toEqual([agent]);
  });
});

describe("serviceVolumes", () => {
  it("lists the existing volumes the config's services name", async () => {
    const fake = createFakeBackend();

    await started(fake);

    expect((await serviceVolumes(fake.backend, STATE, [db, cache])).map((entry) => entry.name)).toEqual([
      dbVolume,
    ]);
    expect(await serviceVolumes(fake.backend, STATE, [cache])).toEqual([]);
  });
});
