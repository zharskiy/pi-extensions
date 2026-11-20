import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { isPlainObject } from "../../../platform/shared/index.ts";
import { pathKey } from "./path-key.ts";
import { pooled } from "./pool.ts";
import { entriesIn } from "./real-dirs.ts";
import { NAMESPACE } from "./settings.ts";

const MARKER_EXT = ".json";

export type Live = { ids: Set<string>; files: Set<string>; dead: string[] };

type Current = Pick<SessionInfo, "agentDir" | "id" | "file" | "parentSession">;

type Marker = { id: string; pid: number; file?: unknown; parentSession?: unknown };

export const liveDir = (agentDir: string) => join(agentDir, NAMESPACE, "live");

const removeMarker = (path: string) => {
  try {
    rmSync(path, { force: true });
  } catch {
    return;
  }
};

const writeMarker = (path: string, info: Current) => {
  const temp = `${path}.tmp`;
  const marker = {
    id: info.id,
    pid: process.pid,
    file: info.file ?? null,
    parentSession: info.parentSession ?? null,
  };

  try {
    mkdirSync(dirname(path), { recursive: true });

    if (!lstatSync(dirname(path)).isDirectory()) {
      return false;
    }

    writeFileSync(temp, JSON.stringify(marker));
    renameSync(temp, path);

    return true;
  } catch {
    removeMarker(temp);

    return false;
  }
};

export const claimMarker = (owner: { marker?: string }, info: Current) => {
  const next = join(liveDir(info.agentDir), `${info.id}.${process.pid}${MARKER_EXT}`);
  const written = writeMarker(next, info);

  if (owner.marker && owner.marker !== next) {
    removeMarker(owner.marker);
  }

  owner.marker = written ? next : undefined;

  return written ? undefined : `${liveDir(info.agentDir)}: cannot write the liveness marker`;
};

export const releaseMarker = (owner: { marker?: string }) => {
  if (!owner.marker) {
    return;
  }

  removeMarker(owner.marker);
  owner.marker = undefined;
};

export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const readMarker = async (path: string) => ({
  path,
  data: parsed(await readFile(path, "utf8").catch(() => "")),
});

const paths = (owner: { file?: unknown; parentSession?: unknown }) =>
  [owner.file, owner.parentSession].filter((path): path is string => typeof path === "string").map(pathKey);

export const isLive = (live: Live, id: string | undefined, file: string) =>
  (id !== undefined && live.ids.has(id)) || live.files.has(pathKey(file));

export const readLive = async (
  current: Current,
  isAlive: (pid: number) => boolean,
): Promise<Live | undefined> => {
  const dir = liveDir(current.agentDir);
  const entries = await entriesIn(dir);

  if (!entries) {
    return undefined;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MARKER_EXT))
    .map((entry) => join(dir, entry.name));
  const markers = await pooled(files, readMarker, 1);

  const live = (data: unknown): data is Marker =>
    isPlainObject(data) && typeof data.id === "string" && typeof data.pid === "number" && isAlive(data.pid);

  const checked = markers.map(({ path, data }) => ({ path, marker: live(data) ? data : undefined }));
  const alive = checked.flatMap(({ marker }) => (marker ? [marker] : []));

  return {
    ids: new Set([current.id, ...alive.map((marker) => marker.id)]),
    files: new Set([...paths(current), ...alive.flatMap(paths)]),
    dead: checked.filter(({ marker }) => !marker).map(({ path }) => path),
  };
};
