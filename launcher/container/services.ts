import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Backend,
  type ContainerSpec,
  type ContainerSummary,
  installIdOf,
  LABELS,
  type MountSpec,
  roleOf,
  SERVICES_ALIAS,
} from "../backend/index.ts";
import {
  DEFAULT_PIDS,
  DEFAULT_READY_SECONDS,
  DEFAULT_SERVICE_USER,
  type ServiceEntry,
} from "../config/index.ts";
import { errorMessage, LauncherError, stableHash } from "../shared/index.ts";
import { chownRoots, discardContainer } from "./lifecycle.ts";
import { configVolumeName, podName, serviceContainerName } from "./names.ts";
import { HANDOVER_CAPABILITIES } from "./spec.ts";
import { serviceVolumeNames } from "./volumes.ts";

export interface ServicesInput {
  backend: Backend;
  stateDir: string;
  services: ServiceEntry[];
  image: string;
  othersLive: () => Promise<boolean>;
  report: (line: string) => void;
  signal?: AbortSignal;
}

interface ResolvedService {
  index: number;
  name: string;
  image: string;
  command: string[];
  user: string;
  env: Record<string, string>;
  volumes: Array<{ name: string; target: string }>;
  tmpfs: string[];
  ready?: { command: string[]; timeoutSeconds: number };
  memoryGiB?: number;
  shmMiB?: number;
}

const SERVICE_STOP_SECONDS = 30;

const LOG_LINES = 40;

const READY_POLL_MS = 500;

const POD_USER = "65534:65534";

const POD_PIDS = 64;

const POD_VOLUMES = "/pi-sandbox/service-volumes";

const SERVICE_TMPFS = "mode=1777";

const CHANGED_NOTICE =
  "pi-sandbox: the services in the config changed; they restart once every pi session has ended";

const volume = (name: string, target: string): MountSpec => ({
  source: name,
  target,
  readOnly: false,
  kind: "volume",
});

const resolveService = async (
  input: ServicesInput,
  service: ServiceEntry,
  index: number,
): Promise<ResolvedService> => {
  const image = service.image === undefined ? input.image : (await input.backend.pullImage(service.image)).id;
  return {
    index,
    name: service.name,
    image,
    command: service.command,
    user: service.user ?? DEFAULT_SERVICE_USER,
    env: service.env ?? {},
    volumes: (service.volumes ?? []).map((entry) => ({
      name: configVolumeName(input.stateDir, entry.name),
      target: entry.target,
    })),
    tmpfs: ["/tmp", ...(service.tmpfs ?? [])],
    memoryGiB: service.memoryGiB,
    shmMiB: service.shmMiB,
    ready:
      service.ready === undefined
        ? undefined
        : {
            command: service.ready.command,
            timeoutSeconds: service.ready.timeoutSeconds ?? DEFAULT_READY_SECONDS,
          },
  };
};

const servicesHashOf = (image: string, services: ResolvedService[]) => stableHash({ image, services });

const distinctVolumes = (services: ResolvedService[]) => [
  ...new Map(
    services.flatMap((service) =>
      service.volumes.map((entry) => [entry.name, { ...entry, user: service.user }]),
    ),
  ).values(),
];

const podTarget = (name: string) => `${POD_VOLUMES}/${name}`;

const podSpec = (
  input: ServicesInput,
  services: ResolvedService[],
  hash: string,
  network: string,
): ContainerSpec => ({
  name: podName(installIdOf(input.stateDir)),
  image: input.image,
  labels: { [LABELS.role]: "pod", [LABELS.servicesHash]: hash },
  mounts: distinctVolumes(services).map((entry) => volume(entry.name, podTarget(entry.name))),
  network: { kind: "internal", name: network, alias: SERVICES_ALIAS },
  env: {},
  readOnlyRoot: true,
  tmpfs: [`/tmp:${SERVICE_TMPFS}`],
  init: true,
  resources: { pids: POD_PIDS },
  user: POD_USER,
  entrypoint: ["sleep", "infinity"],
  command: [],
  capabilities: HANDOVER_CAPABILITIES,
  autoRemove: false,
});

const serviceSpec = (install: string, service: ResolvedService, pod: string): ContainerSpec => ({
  name: serviceContainerName(install, service.name),
  image: service.image,
  labels: { [LABELS.role]: "service", [LABELS.serviceName]: service.name },
  mounts: service.volumes.map((entry) => volume(entry.name, entry.target)),
  network: { kind: "container", id: pod },
  env: service.env,
  readOnlyRoot: true,
  tmpfs: service.tmpfs.map((path) => `${path}:${SERVICE_TMPFS}`),
  init: true,
  resources: { pids: DEFAULT_PIDS, memoryGiB: service.memoryGiB, shmMiB: service.shmMiB },
  user: service.user,
  entrypoint: service.command,
  command: [],
  capabilities: [],
  autoRemove: false,
});

const inOrder = <T>(items: T[], action: (item: T) => Promise<unknown>) =>
  items.reduce<Promise<unknown>>(async (previous, item) => {
    await previous;

    return action(item);
  }, Promise.resolve());

const handOver = async (input: ServicesInput, pod: string, services: ResolvedService[]) => {
  const volumes = distinctVolumes(services);
  const users = [...new Set(volumes.map((entry) => entry.user))];

  await inOrder(users, async (user) => {
    const paths = volumes.filter((entry) => entry.user === user).map((entry) => podTarget(entry.name));
    const result = await chownRoots(input.backend, pod, user, paths);

    if (result.code !== 0) {
      throw new LauncherError(
        `the service volumes could not be handed to ${user}: ${result.stderr.trim()}`,
        "check the volumes in services",
      );
    }
  });
};

const discard = () => new Writable({ write: (_chunk, _encoding, done) => done() });

const readyOnce = (input: ServicesInput, id: string, service: ResolvedService, deadline: number) => {
  const timeout = AbortSignal.timeout(Math.max(deadline - Date.now(), 1));
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const command = service.ready?.command ?? [];

  return input.backend
    .exec(
      { containerId: id, command, env: {}, workdir: "/", user: service.user },
      { stdout: discard(), stderr: discard(), tty: false, signal },
    )
    .then(
      (code) => code === 0,
      () => false,
    );
};

const failure = async (input: ServicesInput, id: string, service: ResolvedService, problem: string) => {
  const logs = await input.backend
    .containerLogs(id, LOG_LINES)
    .catch((error: unknown) => errorMessage(error));
  const tail = logs.trim() === "" ? "" : `\n${logs.trimEnd()}`;

  return new LauncherError(
    `service ${service.name} ${problem}${tail}`,
    `check services[${service.index}] in the config`,
  );
};

const assertRunning = async (input: ServicesInput, id: string, service: ResolvedService) => {
  const state = await input.backend.inspectContainer(id);

  if (state?.state !== "running") {
    throw await failure(
      input,
      id,
      service,
      `exited with code ${state?.exitCode ?? "unknown"} before it was ready`,
    );
  }
};

const awaitReady = async (
  input: ServicesInput,
  id: string,
  service: ResolvedService,
  deadline: number,
): Promise<void> => {
  input.signal?.throwIfAborted();

  if (service.ready === undefined) {
    return assertRunning(input, id, service);
  }

  if (await readyOnce(input, id, service, deadline)) {
    return;
  }

  input.signal?.throwIfAborted();

  await assertRunning(input, id, service);

  if (Date.now() >= deadline) {
    throw await failure(input, id, service, `was not ready within ${service.ready.timeoutSeconds} s`);
  }

  await delay(READY_POLL_MS, undefined, { signal: input.signal });

  return awaitReady(input, id, service, deadline);
};

const startService = async (input: ServicesInput, service: ResolvedService, pod: string) => {
  input.signal?.throwIfAborted();

  input.report(`pi-sandbox: starting service ${service.name}`);

  await Promise.all(service.volumes.map((entry) => input.backend.ensureVolume(entry.name)));

  const { id } = await input.backend.createContainer(serviceSpec(installIdOf(input.stateDir), service, pod));

  await input.backend.startContainer(id);

  const deadline = Date.now() + (service.ready?.timeoutSeconds ?? 0) * 1000;

  await awaitReady(input, id, service, deadline);
};

const ofRole = (containers: ContainerSummary[], role: string) =>
  containers.filter((container) => roleOf(container.labels) === role);

const SERVICE_ROLES: Array<string | undefined> = ["pod", "service"];

export const installServices = async (backend: Backend) =>
  (await backend.findContainers({})).filter((container) => SERVICE_ROLES.includes(roleOf(container.labels)));

const freshPod = async (
  input: ServicesInput,
  services: ResolvedService[],
  hash: string,
  containers: ContainerSummary[],
) => {
  await stopServicesIn(input.backend, containers);

  await Promise.all(distinctVolumes(services).map((entry) => input.backend.ensureVolume(entry.name)));

  const network = await input.backend.prepareNetwork();

  const { id } = await input.backend.createContainer(podSpec(input, services, hash, network));

  await input.backend.startContainer(id);

  await handOver(input, id, services);

  await inOrder(services, (service) => startService(input, service, id));

  return id;
};

const refreshServices = async (
  input: ServicesInput,
  services: ResolvedService[],
  pod: string,
  containers: ContainerSummary[],
) => {
  const existing = ofRole(containers, "service");

  await inOrder(services, async (service) => {
    const current = existing.find((container) => container.labels[LABELS.serviceName] === service.name);

    if (current?.state === "running") {
      return awaitReady(input, current.id, service, Date.now() + (service.ready?.timeoutSeconds ?? 0) * 1000);
    }

    if (current !== undefined) {
      await input.backend.removeContainer(current.id);
    }

    await startService(input, service, pod);
  });
};

const restartOne = async (input: ServicesInput, container: ContainerSummary) => {
  const name = container.labels[LABELS.serviceName];

  input.report(`pi-sandbox: starting service ${name}`);

  const started = await input.backend.startContainer(container.id).then(
    async () => (await input.backend.inspectContainer(container.id))?.state === "running",
    () => false,
  );

  if (!started) {
    throw new LauncherError(
      `service ${name} is stopped and could not be started`,
      "end every pi session, so the services start afresh from the config",
    );
  }
};

const restartStopped = (input: ServicesInput, containers: ContainerSummary[]) =>
  inOrder(
    ofRole(containers, "service").filter((container) => container.state !== "running"),
    (container) => restartOne(input, container),
  );

export type PodPlan = "fresh" | "refresh" | "keep";

export const decide = (pod: ContainerSummary, hash: string, othersLive: boolean): PodPlan => {
  if (pod.labels[LABELS.servicesHash] === hash) {
    return "refresh";
  }

  return othersLive ? "keep" : "fresh";
};

const bringUp = async (input: ServicesInput, services: ResolvedService[]) => {
  const hash = servicesHashOf(input.image, services);
  const containers = await installServices(input.backend);
  const pod = ofRole(containers, "pod").find((container) => container.state === "running");

  if (pod === undefined) {
    return freshPod(input, services, hash, containers);
  }

  const plan = decide(pod, hash, await input.othersLive());

  if (plan === "fresh") {
    return freshPod(input, services, hash, containers);
  }

  if (plan === "refresh") {
    await refreshServices(input, services, pod.id, containers);
  }

  if (plan === "keep") {
    input.report(CHANGED_NOTICE);

    await restartStopped(input, containers);
  }

  return pod.id;
};

export const ensureServices = async (input: ServicesInput) => {
  const services = await Promise.all(
    input.services.map((service, index) => resolveService(input, service, index)),
  );

  try {
    await bringUp(input, services);
  } catch (error) {
    const shared = await input.othersLive().catch(() => true);

    if (!shared) {
      await stopServices(input.backend).catch(() => undefined);
    }

    throw error;
  }
};

const stopServicesIn = async (backend: Backend, containers: ContainerSummary[]) => {
  const services = ofRole(containers, "service");
  const pods = ofRole(containers, "pod");

  const stopped = await Promise.allSettled(
    services.map((service) => discardContainer(backend, service, SERVICE_STOP_SECONDS)),
  );
  const failed = stopped.find((outcome) => outcome.status === "rejected");

  if (failed !== undefined) {
    throw failed.reason;
  }

  await Promise.all(pods.map((pod) => discardContainer(backend, pod)));

  return [...services, ...pods];
};

export const stopServices = async (backend: Backend) =>
  stopServicesIn(backend, await installServices(backend));

export const serviceVolumes = async (backend: Backend, stateDir: string, services: ServiceEntry[]) => {
  const names = serviceVolumeNames(stateDir, services);

  return (await backend.listVolumes()).filter((entry) => names.has(entry.name));
};
