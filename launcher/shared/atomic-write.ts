import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage, LauncherError } from "./errors.ts";

interface AtomicWriteOptions {
  mode?: number;
}

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
