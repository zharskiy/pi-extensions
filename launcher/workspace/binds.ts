import { lstatSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expandHome, isWithin, LauncherError, printable, realOrResolvedSync } from "../shared/index.ts";
import { pathRefusal, type RootGuardContext, shareProblem } from "./roots.ts";

interface BindEntry {
  source: string;
  target: string;
}

interface BindContext extends RootGuardContext {
  roots: string[];
}

export interface HostBind {
  key: string;
  source: string;
  target: string;
  share: string;
  directory: boolean;
}

export interface VolumeSource {
  index: number;
  written: string;
  requested: string;
  source: string;
}

interface GuardedSource {
  key: string;
  written: string;
  source: string;
  share: string;
}

interface SourceHints {
  refused: string;
  overlap: string;
}

const BIND_HINTS: SourceHints = {
  refused: "bind a folder or file other than the home dir, apart from the paths the sandbox protects",
  overlap: "bind a folder or file apart from the folders the sandbox already mounts",
};

const VOLUME_SOURCE_HINTS: SourceHints = {
  refused: "copy a folder other than the home dir, apart from the paths the sandbox protects",
  overlap: "copy a folder apart from the folders the sandbox already mounts",
};

const keyOf = (index: number) => `mounts.binds[${index}].source`;

const realOf = (path: string, home: string) => realOrResolvedSync(resolve(expandHome(path, home)));

const overlapping = (source: string, roots: string[]) =>
  roots.find((root) => isWithin(source, root) || isWithin(root, source));

const guardSource = (guarded: GuardedSource, hints: SourceHints, context: BindContext) => {
  const { key, written, source } = guarded;
  const problem = shareProblem(source, context) ?? shareProblem(guarded.share, context);

  if (problem !== undefined) {
    throw pathRefusal(key, hints.refused, written, problem);
  }

  const root = overlapping(
    source,
    context.roots.map((path) => realOf(path, context.home)),
  );

  if (root !== undefined) {
    throw new LauncherError(
      `config: ${key}: ${printable(written)} overlaps ${printable(root)}, which the sandbox already mounts`,
      hints.overlap,
    );
  }
};

const hostBind = (entry: BindEntry, index: number, context: BindContext): HostBind => {
  const key = keyOf(index);
  const source = realOf(entry.source, context.home);
  const stats = statSync(source, { throwIfNoEntry: false });

  if (stats === undefined) {
    throw new LauncherError(
      `config: ${key}: ${printable(entry.source)} does not exist`,
      "create it, or remove the entry from mounts.binds",
    );
  }

  const directory = stats.isDirectory();
  const share = directory ? source : dirname(source);

  guardSource({ key, written: entry.source, source, share }, BIND_HINTS, context);

  return { key, source, target: entry.target, share, directory };
};

export const hostBinds = (binds: BindEntry[], context: BindContext) =>
  binds.map((entry, index) => hostBind(entry, index, context));

const volumeSource = (written: string, index: number, context: BindContext): VolumeSource => {
  const requested = resolve(expandHome(written, context.home));
  const source = realOrResolvedSync(requested);
  const key = `mounts.volumes[${index}].source`;

  guardSource({ key, written, source, share: source }, VOLUME_SOURCE_HINTS, context);

  return { index, written, requested, source };
};

export const hostVolumeSources = (volumes: Array<string | { source?: string }>, context: BindContext) =>
  volumes.flatMap((entry, index) =>
    typeof entry === "string" || entry.source === undefined
      ? []
      : [volumeSource(entry.source, index, context)],
  );

const unchanged = (bind: HostBind) => {
  const stats = lstatSync(bind.source, { throwIfNoEntry: false });

  return (
    stats !== undefined &&
    !stats.isSymbolicLink() &&
    stats.isDirectory() === bind.directory &&
    realOrResolvedSync(bind.source) === bind.source
  );
};

export const confirmBinds = (binds: HostBind[]) => {
  const changed = binds.find((bind) => !unchanged(bind));

  if (changed !== undefined) {
    throw new LauncherError(
      `config: ${changed.key}: ${printable(changed.source)} changed while pi was starting, refusing`,
      "run pi again",
    );
  }
};
