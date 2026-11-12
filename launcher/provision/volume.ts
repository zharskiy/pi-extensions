import { posix } from "node:path";
import { type Backend, ExecTimeoutError, execCapture } from "../backend/index.ts";
import type { JsonObject } from "../hostpi/index.ts";
import { errorMessage, GUEST_PATHS, LauncherError, parseJsonObject } from "../shared/index.ts";

export interface VolumeRead {
  value?: JsonObject;
  invalid: boolean;
}

const WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && cat > "$1.pi-sandbox-tmp" && mv "$1.pi-sandbox-tmp" "$1"';

const REGULAR_FILE_GUARD = '[ -f "$1" ] || { [ -e "$1" ] || [ -L "$1" ] && exit 4; exit 3; }';

const READ_SCRIPT = `${REGULAR_FILE_GUARD}; head -c "$2" "$1"`;

const CAT_SCRIPT = `${REGULAR_FILE_GUARD}; cat "$1"`;

const REMOVE_SCRIPT = 'rm -f "$1"';

const REMOVE_DIRS_SCRIPT = 'rm -rf -- "$@"';

const MISSING_EXIT = 3;

const NOT_REGULAR_EXIT = 4;

const READ_TIMEOUT_MS = 5000;

const guestPath = (name: string) => posix.join(GUEST_PATHS.agentDir, name);

const parse = (text: string): VolumeRead => {
  const value = parseJsonObject(text);

  return value === undefined ? { invalid: true } : { value, invalid: false };
};

export const readVolumeFile = async (
  backend: Backend,
  containerId: string,
  name: string,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<VolumeRead> => {
  const result = await execCapture(
    backend,
    { containerId, command: ["sh", "-c", CAT_SCRIPT, "sh", guestPath(name)], env: {}, workdir: "/" },
    "",
    timeoutMs,
  ).catch((error: unknown) => {
    if (error instanceof ExecTimeoutError) {
      return undefined;
    }

    throw error;
  });

  if (result === undefined || result.code === NOT_REGULAR_EXIT) {
    return { invalid: true };
  }

  return result.code === 0 && result.stdout.trim() !== "" ? parse(result.stdout) : { invalid: false };
};

export const writeVolumeFile = async (
  backend: Backend,
  containerId: string,
  name: string,
  value: JsonObject,
) => {
  const result = await execCapture(
    backend,
    { containerId, command: ["sh", "-c", WRITE_SCRIPT, "sh", guestPath(name)], env: {}, workdir: "/" },
    `${JSON.stringify(value, null, 2)}\n`,
  );

  if (result.code !== 0) {
    throw new LauncherError(`${name}: could not write it into the sandbox volume (exit ${result.code})`);
  }
};

export const readVolumeText = async (
  backend: Backend,
  containerId: string,
  name: string,
  maxBytes: number,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<string | undefined> => {
  const result = await execCapture(
    backend,
    {
      containerId,
      command: ["sh", "-c", READ_SCRIPT, "sh", guestPath(name), String(maxBytes + 1)],
      env: {},
      workdir: "/",
    },
    "",
    timeoutMs,
  ).catch((error: unknown) => {
    throw new LauncherError(`${name}: could not read it from the sandbox volume: ${errorMessage(error)}`);
  });

  if (result.code === MISSING_EXIT) {
    return undefined;
  }

  if (result.code === NOT_REGULAR_EXIT) {
    throw new LauncherError(`${name}: it is not a regular file in the sandbox volume`);
  }

  if (result.code !== 0) {
    throw new LauncherError(`${name}: could not read it from the sandbox volume (exit ${result.code})`);
  }

  return result.stdout;
};

export const removeVolumeDirs = async (backend: Backend, containerId: string, names: string[]) => {
  const result = await execCapture(backend, {
    containerId,
    command: ["sh", "-c", REMOVE_DIRS_SCRIPT, "sh", ...names.map(guestPath)],
    env: {},
    workdir: "/",
  });

  if (result.code !== 0) {
    throw new LauncherError(
      `could not remove the outdated packages from the sandbox volume (exit ${result.code})`,
    );
  }
};

export const removeVolumeFile = async (backend: Backend, containerId: string, name: string) => {
  const result = await execCapture(backend, {
    containerId,
    command: ["sh", "-c", REMOVE_SCRIPT, "sh", guestPath(name)],
    env: {},
    workdir: "/",
  });

  if (result.code !== 0) {
    throw new LauncherError(`${name}: could not remove it from the sandbox volume (exit ${result.code})`);
  }
};
