import { rm } from "node:fs/promises";
import { type Backend, busyText, installIdOf, LABELS, type VolumeSummary } from "../../backend/index.ts";
import { loadEffectiveConfig, type SandboxConfig } from "../../config/index.ts";
import {
  agentVolumeName,
  configVolumeName,
  isLegacyAgentVolume,
  isSharedVolumeName,
  listLauncherContainers,
  mountedVolumes,
} from "../../container/index.ts";
import { removeBuildLeftovers } from "../../image/index.ts";
import { knownRepos, LauncherError, stateLayout, withFileLock } from "../../shared/index.ts";
import { vmSessions } from "../busy.ts";
import { type CliDeps, pathsOf, writeLine, writeLines } from "../deps.ts";
import { removeGround } from "../ground.ts";
import { withAgentLock } from "../prepare.ts";
import { createPlainPrompts } from "../prompt/plain.ts";
import { createRichPrompts } from "../prompt/rich.ts";
import { findTerminal, isSet, withTerminal } from "../prompt/terminal.ts";
import { Cancelled, type Ui } from "../prompt/types.ts";
import { releaseRepos, removeStored, withInstallReleased } from "../release.ts";
import { configuredVmStart, startConfiguredVm } from "../vm.ts";

export const RESTART_OPTIONS_HINT = "pi sandbox restart takes no options; it removes everything";

const RENDER_LOCK_TIMEOUT_MS = 30_000;

const DECLINED_EXIT = 130;

type VolumeKind = "pi folder" | "build output" | "package caches" | "service data" | "other";

const VOLUME_KINDS: VolumeKind[] = ["pi folder", "build output", "package caches", "service data", "other"];

interface Stake {
  services: string[];
  unnamed: number;
  sessions: boolean;
}

interface Wiped {
  containers: number;
  volumes: VolumeKind[];
  images: number;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const TEXT = {
  intro:
    "pi sandbox restart removes the sandbox's caches (containers, volumes and images) and the next pi rebuilds them from your config",
  busy: (sessions: Parameters<typeof busyText>[0]) => `${busyText(sessions)} in the sandbox VM`,
  busyHint: "exit them, then run pi sandbox restart again",
  meanwhile: (sessions: Parameters<typeof busyText>[0]) =>
    `a pi session started in the sandbox VM meanwhile (${busyText(sessions)}), so the sandbox network, services, volumes and images were kept`,
  meanwhileHint: "exit it, then run pi sandbox restart again",
  stakeLines: (stake: Stake) => [
    ...stake.services.map((service) => `the data of service ${service}`),
    ...(stake.unnamed === 0
      ? []
      : [
          `${plural(stake.unnamed, "volume", "volumes")} no config entry names, such as a removed service's data`,
        ]),
    ...(stake.sessions ? ["the pi sessions kept in the sandbox while sessions.host is off"] : []),
  ],
  stakeTitle: "Delete it and restart the sandbox?",
  stakeIntro: "This also deletes data the next pi cannot rebuild:",
  yes: "Yes, delete it",
  no: "No, keep everything",
  noTerminal: (stake: Stake, why: string) =>
    `pi sandbox restart would delete data the next pi cannot rebuild (${TEXT.stakeLines(stake).join("; ")}), and ${why}`,
  noTerminalHint: "run pi sandbox restart at a terminal to confirm",
  declined: "nothing was removed",
  removedContainers: (count: number) => `removed ${plural(count, "container", "containers")}`,
  removedVolumes: (kinds: VolumeKind[]) => {
    const counts = VOLUME_KINDS.map((kind) => [kind, kinds.filter((each) => each === kind).length] as const)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind} ${count}`);

    return `removed ${plural(kinds.length, "volume", "volumes")}${counts.length === 0 ? "" : `: ${counts.join(", ")}`}`;
  },
  removedImages: (count: number) => `removed ${plural(count, "image", "images")}`,
  restarted: "restarted the sandbox VM",
  notRestarted: "the sandbox VM did not restart; the next pi starts it",
  nextPi: "the next pi rebuilds the image and reinstalls your extensions",
};

const serviceOwners = (config: SandboxConfig, stateDir: string) =>
  new Map(
    config.services.flatMap((service) =>
      (service.volumes ?? []).map((entry) => [configVolumeName(stateDir, entry.name), service.name] as const),
    ),
  );

const kindOf = (config: SandboxConfig, stateDir: string) => {
  const install = installIdOf(stateDir);
  const caches = new Set(mountedVolumes(config, stateDir).map((volume) => volume.name));
  const services = serviceOwners(config, stateDir);

  return (name: string, labels: Record<string, string> = {}): VolumeKind => {
    if (name === agentVolumeName(install) || isLegacyAgentVolume(install, name)) {
      return "pi folder";
    }

    if (isSharedVolumeName(name)) {
      return caches.has(name) && !services.has(name) ? "package caches" : "service data";
    }

    return labels[LABELS.repoHash] === undefined ? "other" : "build output";
  };
};

const stakeOf = (config: SandboxConfig, stateDir: string, volumes: VolumeSummary[]): Stake => {
  const kind = kindOf(config, stateDir);
  const owners = serviceOwners(config, stateDir);
  const data = volumes.filter((volume) => kind(volume.name, volume.labels) === "service data");
  const named = data.flatMap((volume) => {
    const owner = owners.get(volume.name);

    return owner === undefined ? [] : [owner];
  });
  const piFolders = volumes.filter((volume) => kind(volume.name, volume.labels) === "pi folder");

  return {
    services: [...new Set(named)],
    unnamed: data.filter((volume) => !owners.has(volume.name)).length,
    sessions: !config.sessions.host && piFolders.length > 0,
  };
};

const atStake = (stake: Stake) => TEXT.stakeLines(stake).length > 0;

const askAtTerminal = (deps: CliDeps, ui: Ui, stake: Stake) => {
  const prompts = ui.mode === "rich" ? createRichPrompts(ui) : createPlainPrompts(ui);
  const signal: { decline?: () => void } = {};
  const declined = new Promise<boolean>((resolve) => {
    signal.decline = () => resolve(false);
  });
  const guards = { signals: deps.signals ?? process, exits: process, onSignal: () => signal.decline?.() };

  const ask = async () => {
    const reply = await prompts
      .confirm({
        title: TEXT.stakeTitle,
        detail: [TEXT.stakeIntro, ...TEXT.stakeLines(stake).map((line) => `- ${line}`)],
        yes: TEXT.yes,
        no: TEXT.no,
        initial: false,
        collapsed: () => undefined,
      })
      .catch((error: unknown) => {
        if (error instanceof Cancelled) {
          return false;
        }

        throw error;
      });

    return reply === true;
  };

  return withTerminal(ui, guards, () => Promise.race([ask(), declined]));
};

const confirmed = async (deps: CliDeps, stake: Stake) => {
  if (!atStake(stake)) {
    return true;
  }

  if (isSet(deps.env.CI)) {
    throw new LauncherError(TEXT.noTerminal(stake, "CI is set"), TEXT.noTerminalHint);
  }

  const ui = findTerminal({
    stdin: deps.terminal.stdin,
    stderr: deps.terminal.stderr,
    env: deps.env,
    openTty: deps.openTty,
  });

  if (ui === undefined) {
    throw new LauncherError(TEXT.noTerminal(stake, "asking needs a terminal"), TEXT.noTerminalHint);
  }

  return askAtTerminal(deps, ui, stake);
};

const clearRecords = async (stateDir: string) => {
  const layout = stateLayout(stateDir);
  const legacy = (await knownRepos(stateDir)).map((hash) => layout.repo(hash).legacy.sync);
  const paths = [layout.render, layout.renders, layout.sync.directory, layout.imageRecord, ...legacy];

  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));

  await removeBuildLeftovers(stateDir);
};

const releaseInstall = (deps: CliDeps, stateDir: string, backend: Backend) => {
  const progress = (line: string) => writeLine(deps.stderr, line);

  return withAgentLock({ stateDir, progress }, () =>
    withFileLock(
      stateLayout(stateDir).renderLock,
      () =>
        withInstallReleased(deps, stateDir, async () => {
          await removeGround(deps, stateDir, backend);

          const stored = await removeStored(backend);

          await clearRecords(stateDir);

          return stored;
        }),
      { timeoutMs: RENDER_LOCK_TIMEOUT_MS },
    ),
  );
};

const wipe = async (deps: CliDeps, config: SandboxConfig, backend: Backend): Promise<Wiped> => {
  const { stateDir } = pathsOf(deps);
  const before = (await listLauncherContainers(backend)).length;
  const labelsOf = new Map((await backend.listVolumes()).map((volume) => [volume.name, volume.labels]));

  await releaseRepos(deps, stateDir, backend);

  const install = await releaseInstall(deps, stateDir, backend);

  if ("busy" in install) {
    throw new LauncherError(TEXT.meanwhile(install.busy), TEXT.meanwhileHint);
  }

  const after = (await listLauncherContainers(backend)).length;
  const kind = kindOf(config, stateDir);

  return {
    containers: Math.max(before - after, 0),
    volumes: install.released.volumes.map((name) => kind(name, labelsOf.get(name))),
    images: install.released.images.filter(Boolean).length,
  };
};

const restartVm = async (deps: CliDeps, backend: Backend, start: Parameters<typeof startConfiguredVm>[1]) => {
  const { stateDir } = pathsOf(deps);

  try {
    await backend.vm.stop({ busy: () => vmSessions(backend, stateDir) });

    await startConfiguredVm(backend, start, (line) => writeLine(deps.stderr, line));

    return undefined;
  } catch (error) {
    return error;
  }
};

const wipedLines = (wiped: Wiped, restarted: boolean) => [
  TEXT.removedContainers(wiped.containers),
  TEXT.removedVolumes(wiped.volumes),
  TEXT.removedImages(wiped.images),
  restarted ? TEXT.restarted : TEXT.notRestarted,
  TEXT.nextPi,
];

export const restartCommand = async (deps: CliDeps) => {
  const { stateDir } = pathsOf(deps);
  const backend = deps.backend();
  const sessions = await vmSessions(backend, stateDir);

  if (sessions.count > 0) {
    throw new LauncherError(TEXT.busy(sessions), TEXT.busyHint);
  }

  const { config } = await loadEffectiveConfig({ env: deps.env, home: deps.home });

  writeLine(deps.stdout, TEXT.intro);

  const start = await configuredVmStart(deps, config);

  await startConfiguredVm(backend, start, (line) => writeLine(deps.stderr, line));

  const stake = stakeOf(config, stateDir, await backend.listVolumes());

  if (!(await confirmed(deps, stake))) {
    writeLine(deps.stdout, TEXT.declined);

    return DECLINED_EXIT;
  }

  const wiped = await wipe(deps, config, backend);
  const failure = await restartVm(deps, backend, start);

  writeLines(deps.stdout, wipedLines(wiped, failure === undefined));

  if (failure !== undefined) {
    throw failure;
  }

  return 0;
};
