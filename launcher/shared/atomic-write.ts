import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage, LauncherError } from "./errors.ts";

interface AtomicWriteOptions {
  mode?: number;
}

const PRIVATE_FILE_MODE = 0o600;

const PRIVATE_DIR_MODE = 0o700;

const writeAndSync = async (path: string, data: string | Uint8Array, mode: number | undefined) => {
  const handle = await open(path, "wx", mode);

  try {
    await handle.writeFile(data);

    if (mode !== undefined) {
      await handle.chmod(mode);
    }

    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const writeFileAtomic = async (
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
) => {
  const temporary = temporaryOf(path);

  try {
    await mkdir(dirname(path), { recursive: true });

    await writeAndSync(temporary, data, options.mode);

    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);

    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

const HEX_PATTERN = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);

const readHexFile = async (path: string, pattern: RegExp) => {
  const text = await readFile(path, "utf8").catch(() => "");

  return pattern.test(text) ? text : undefined;
};

const temporaryOf = (path: string) => `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

const linkNew = async (temporary: string, path: string) => {
  try {
    await link(temporary, path);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw new LauncherError(`${path}: ${errorMessage(error)}`);
  }
};

export const writeNewFile = async (path: string, data: string, options: AtomicWriteOptions = {}) => {
  const temporary = temporaryOf(path);

  await mkdir(dirname(path), { recursive: true });

  try {
    await writeAndSync(temporary, data, options.mode);

    return await linkNew(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const createHexFile = async (path: string, pattern: RegExp, bytes: number) => {
  const value = randomBytes(bytes).toString("hex");
  const temporary = temporaryOf(path);

  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });

  try {
    await writeAndSync(temporary, value, PRIVATE_FILE_MODE);

    if (await linkNew(temporary, path)) {
      return value;
    }
  } finally {
    await rm(temporary, { force: true });
  }

  const raced = await readHexFile(path, pattern);

  if (raced !== undefined) {
    return raced;
  }

  await writeFileAtomic(path, value, { mode: PRIVATE_FILE_MODE });

  return value;
};

export const ensureRandomHexFile = async (path: string, bytes: number): Promise<string> => {
  const pattern = HEX_PATTERN(bytes);

  return (await readHexFile(path, pattern)) ?? createHexFile(path, pattern, bytes);
};
