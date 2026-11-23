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

const BIND_HINT = "bind a folder or file other than the home dir, apart from the paths the sandbox protects";

const keyOf = (index: number) => `mounts.binds[${index}].source`;

const realOf = (path: string, home: string) => realOrResolvedSync(resolve(expandHome(path, home)));

const overlapping = (source: string, roots: string[]) =>
  roots.find((root) => isWithin(source, root) || isWithin(root, source));

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
  const problem = shareProblem(source, context) ?? shareProblem(share, context);

  if (problem !== undefined) {
    throw pathRefusal(key, BIND_HINT, entry.source, problem);
  }

  const root = overlapping(
    source,
    context.roots.map((path) => realOf(path, context.home)),
  );

  if (root !== undefined) {
    throw new LauncherError(
      `config: ${key}: ${printable(entry.source)} overlaps ${printable(root)}, which the sandbox already mounts`,
      "bind a folder or file apart from the folders the sandbox already mounts",
    );
  }

  return { key, source, target: entry.target, share, directory };
};

export const hostBinds = (binds: BindEntry[], context: BindContext) =>
  binds.map((entry, index) => hostBind(entry, index, context));

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
