import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

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

const createHexFile = async (path: string, pattern: RegExp, bytes: number) => {
  const value = randomBytes(bytes).toString("hex");

  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });

  const created = await writeFile(path, value, { mode: PRIVATE_FILE_MODE, flag: "wx" }).then(
    () => true,
    () => false,
  );

  if (created) {
    return value;
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
