import { realpath, stat } from "node:fs/promises";
import { Writable } from "node:stream";
import { type Backend, execCapture } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import {
  errorMessage,
  LauncherError,
  lastLine,
  printable,
  stateLayout,
  withWaitingLock,
} from "../shared/index.ts";
import type { VolumeSource } from "../workspace/index.ts";
import { type ArchiveTally, sourceArchive } from "./archive.ts";
import { mountedVolumes } from "./volumes.ts";

export interface VolumeSeed {
  requested: string;
  source: string;
  shownSource: string;
  shownTarget: string;
  target: string;
  volume: string;
}

export interface SeedInput {
  backend: Backend;
  containerId: string;
  stateDir: string;
  seeds: VolumeSeed[];
  platform: NodeJS.Platform;
  signal: AbortSignal;
  progress: (line: string) => void;
}

type MarkerState = { kind: "absent" } | { kind: "same" } | { kind: "other"; source: string };

export const SEED_MARKER = ".pinata-seeded";

const STDERR_LIMIT = 4096;

const MARKER_READ_LIMIT = "4096";

export const extractCommand = (target: string) => [
  "tar",
  "-x",
  "-f",
  "-",
  "-C",
  target,
  "--no-same-owner",
  "--no-same-permissions",
];

const markerPathOf = (target: string) => `${target}/${SEED_MARKER}`;

export const markerCheckCommand = (marker: string) => ["test", "-f", marker, "-a", "!", "-L", marker];

export const markerReadCommand = (marker: string) => ["head", "-c", MARKER_READ_LIMIT, "--", marker];

export const markerRemoveCommand = (marker: string) => ["rm", "-f", "--", marker];

export const markerWriteCommand = (marker: string) => ["dd", `of=${marker}`, "conv=excl", "status=none"];

export const volumeSeeds = (
  config: SandboxConfig,
  stateDir: string,
  sources: VolumeSource[],
): VolumeSeed[] => {
  const volumes = mountedVolumes(config, stateDir);

  return sources.flatMap((source) => {
    const volume = volumes[source.index];
    const entry = config.mounts.volumes[source.index];

    if (volume === undefined || entry === undefined) {
      return [];
    }

    return [
      {
        requested: source.requested,
        source: source.source,
        shownSource: printable(source.written),
        shownTarget: printable(typeof entry === "string" ? entry : entry.target),
        target: volume.target,
        volume: volume.name,
      },
    ];
  });
};

const tailSink = () => {
  const state = { text: "" };
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      state.text = `${state.text}${chunk.toString()}`.slice(-STDERR_LIMIT);

      done();
    },
  });

  return { stream, reason: () => lastLine(state.text) };
};

const withReason = (message: string, reason: string | undefined) =>
  reason === undefined ? message : `${message}: ${printable(reason)}`;

const checkSource = async (seed: VolumeSeed) => {
  const real = await realpath(seed.requested).catch(() => undefined);

  if (real === undefined) {
    throw new LauncherError(`${seed.shownSource} does not exist`);
  }

  if (real !== seed.source) {
    throw new LauncherError(
      `${seed.shownSource} now resolves to ${printable(real)}, not to ${printable(seed.source)} as when the config was read`,
    );
  }

  const stats = await stat(real);

  if (!stats.isDirectory()) {
    throw new LauncherError(`${seed.shownSource} is not a folder`);
  }
};

const streamInto = async (input: SeedInput, seed: VolumeSeed) => {
  const archive = sourceArchive(seed.source);
  const guest = tailSink();
  const stopArchive = () => archive.stream.destroy();

  input.signal.addEventListener("abort", stopArchive, { once: true });

  try {
    const code = await input.backend.exec(
      { containerId: input.containerId, command: extractCommand(seed.target), env: {}, workdir: "/" },
      { stdin: archive.stream, stdout: guest.stream, stderr: guest.stream, tty: false, signal: input.signal },
    );

    if (input.signal.aborted) {
      throw new LauncherError("the copy was interrupted");
    }

    if (code !== 0) {
      throw new LauncherError(withReason(`tar in the sandbox exited with code ${code}`, guest.reason()));
    }

    if (!archive.complete()) {
      throw new LauncherError(withReason("the archive ended before its last entry", archive.failure()));
    }

    return archive.tally;
  } finally {
    input.signal.removeEventListener("abort", stopArchive);

    stopArchive();
  }
};

const markerExec = (input: SeedInput, command: string[], stdin = "") =>
  execCapture(input.backend, { containerId: input.containerId, command, env: {}, workdir: "/" }, stdin);

const writeMarker = async (input: SeedInput, seed: VolumeSeed) => {
  const marker = markerPathOf(seed.target);
  const removed = await markerExec(input, markerRemoveCommand(marker));
  const written =
    removed.code === 0 ? await markerExec(input, markerWriteCommand(marker), `${seed.source}\n`) : removed;

  if (written.code !== 0) {
    throw new LauncherError(
      withReason(`the marker ${SEED_MARKER} could not be written`, lastLine(written.stderr)),
    );
  }
};

const markerState = async (input: SeedInput, seed: VolumeSeed): Promise<MarkerState> => {
  const marker = markerPathOf(seed.target);
  const check = await markerExec(input, markerCheckCommand(marker));

  if (check.code !== 0) {
    return { kind: "absent" };
  }

  const read = await markerExec(input, markerReadCommand(marker));
  const recorded = read.code === 0 ? read.stdout.trim() : "";

  return recorded === "" || recorded === seed.source ? { kind: "same" } : { kind: "other", source: recorded };
};

const leftOutText = (tally: ArchiveTally) => {
  const leftOut =
    tally.leftOut === 0
      ? []
      : [
          tally.leftOut === 1
            ? "1 entry could not be read and was left out"
            : `${tally.leftOut} entries could not be read and were left out`,
        ];
  const changed =
    tally.changed === 0
      ? []
      : [
          tally.changed === 1
            ? "1 file changed while it was read"
            : `${tally.changed} files changed while they were read`,
        ];

  return [...leftOut, ...changed].map((part) => `; ${part}`).join("");
};

const copyInto = async (input: SeedInput, seed: VolumeSeed) => {
  await checkSource(seed);

  const tally = await streamInto(input, seed);

  await writeMarker(input, seed);

  return tally;
};

const otherSourceLine = (seed: VolumeSeed, other: string) =>
  `pinata: warning: the volume at ${seed.shownTarget} holds a copy of ${printable(other)}, so ${seed.shownSource} is not copied into it; delete ${seed.shownTarget}/${SEED_MARKER} in the sandbox to copy it`;

const seedVolume = (input: SeedInput, seed: VolumeSeed) =>
  withWaitingLock(
    stateLayout(input.stateDir).seedLock(seed.volume),
    async () => {
      const marker = await markerState(input, seed);

      if (marker.kind === "same") {
        return;
      }

      if (marker.kind === "other") {
        input.progress(otherSourceLine(seed, marker.source));

        return;
      }

      if (input.platform !== "darwin") {
        throw new LauncherError("the copy runs only on macOS");
      }

      input.progress(`pinata: copying ${seed.shownSource} into the volume at ${seed.shownTarget}, one time`);

      const tally = await copyInto(input, seed);

      input.progress(
        `pinata: copied ${seed.shownSource} into the volume at ${seed.shownTarget}${leftOutText(tally)}`,
      );
    },
    {
      signal: input.signal,
      onWait: () =>
        input.progress(`pinata: waiting for another pi session to finish copying into ${seed.shownTarget}`),
    },
  );

const failureLine = (seed: VolumeSeed, error: unknown) =>
  `pinata: warning: ${seed.shownSource} was not copied into the volume at ${seed.shownTarget} (${errorMessage(error)}); the next launch tries again`;

export const seedVolumes = (input: SeedInput) =>
  input.seeds.reduce(async (previous, seed) => {
    await previous;

    await seedVolume(input, seed).catch((error: unknown) => input.progress(failureLine(seed, error)));
  }, Promise.resolve());
