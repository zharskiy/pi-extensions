import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { isPlainObject } from "../../../platform/shared/index.ts";
import { pathKey } from "./path-key.ts";
import { serial } from "./serial.ts";

const MARKER_EXT = ".json";

export type Live = { ids: Set<string>; files: Set<string>; dead: string[] };

export type Current = Pick<SessionInfo, "id" | "file" | "parentSession">;

type Marker = { id: string; pid: number; file?: unknown; parentSession?: unknown };

export const liveDir = (agentDir: string) => join(agentDir, "pi-retention", "live");

export const markerPath = (agentDir: string, id: string) =>
  join(liveDir(agentDir), `${id}.${process.pid}${MARKER_EXT}`);

export const removeMarker = (path: string) => {
  try {
    rmSync(path, { force: true });
  } catch {
    return;
  }
};

const isRealDirSync = (dir: string) => {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
};

export const writeMarker = (path: string, info: Current) => {
  const temp = `${path}.tmp`;
  const marker = {
    id: info.id,
    pid: process.pid,
    file: info.file ?? null,
    parentSession: info.parentSession ?? null,
  };

  try {
    mkdirSync(dirname(path), { recursive: true });

    if (!isRealDirSync(dirname(path))) {
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

const markerFiles = async (dir: string) => {
  const stat = await lstat(dir).catch((error: NodeJS.ErrnoException) => error.code);

  if (stat === "ENOENT") {
    return [];
  }

  if (typeof stat !== "object" || !stat.isDirectory()) {
    return undefined;
  }

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);

  return entries
    ?.filter((entry) => entry.isFile() && entry.name.endsWith(MARKER_EXT))
    .map((entry) => join(dir, entry.name));
};

export const readLive = async (
  agentDir: string,
  current: Current,
  isAlive: (pid: number) => boolean,
): Promise<Live | undefined> => {
  const files = await markerFiles(liveDir(agentDir));

  if (!files) {
    return undefined;
  }

  const markers = await serial(files, readMarker);

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
