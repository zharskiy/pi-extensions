import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { LauncherError } from "./errors.ts";
import { MIB } from "./units.ts";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const MAX_REGULAR_FILE_BYTES = 8 * MIB;

export const lstatOrUndefined = (path: string): Promise<Stats | undefined> =>
  lstat(path).catch(() => undefined);

export const sameEntry = (first: Stats, second: Stats) =>
  first.dev === second.dev && first.ino === second.ino;

export const readRegularFile = async (path: string) => {
  const info = await lstatOrUndefined(path);

  if (info === undefined || !info.isFile()) {
    throw new LauncherError(`${path} is not a regular file`);
  }

  if (info.size > MAX_REGULAR_FILE_BYTES) {
    throw new LauncherError(`${path} is larger than ${MAX_REGULAR_FILE_BYTES} bytes`);
  }

  const handle = await open(path, READ_FLAGS);

  try {
    const opened = await handle.stat();

    if (!opened.isFile() || !sameEntry(opened, info)) {
      throw new LauncherError(`${path} changed while it was read`);
    }

    return { data: await handle.readFile(), mode: opened.mode };
  } finally {
    await handle.close();
  }
};

export const readRegularText = (path: string) =>
  readRegularFile(path).then(
    (file) => file.data.toString("utf8"),
    () => undefined,
  );
