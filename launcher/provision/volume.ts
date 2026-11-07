import { posix } from "node:path";
import { type Backend, execCapture } from "../backend/index.ts";
import type { JsonObject } from "../hostpi/index.ts";
import { GUEST_PATHS, LauncherError, parseJsonObject } from "../shared/index.ts";

export interface VolumeRead {
  value?: JsonObject;
  invalid: boolean;
}

const WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && cat > "$1.pi-sandbox-tmp" && mv "$1.pi-sandbox-tmp" "$1"';

const guestPath = (name: string) => posix.join(GUEST_PATHS.agentDir, name);

const parse = (text: string): VolumeRead => {
  const value = parseJsonObject(text);

  return value === undefined ? { invalid: true } : { value, invalid: false };
};

export const readVolumeFile = async (
  backend: Backend,
  containerId: string,
  name: string,
): Promise<VolumeRead> => {
  const result = await execCapture(backend, {
    containerId,
    command: ["cat", guestPath(name)],
    env: {},
    workdir: "/",
  });

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
