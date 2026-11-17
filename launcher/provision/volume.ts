import { posix } from "node:path";
import { type Backend, execCapture } from "../backend/index.ts";
import type { JsonObject } from "../hostpi/index.ts";
import { errorMessage, GUEST_PATHS, jsonText, LauncherError, MIB, MINUTE_MS } from "../shared/index.ts";
import { parseVolumeText } from "./write-back.ts";

export interface VolumeRead {
  value?: JsonObject;
  invalid: boolean;
}

const WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && cat > "$1.pi-sandbox-tmp" && mv "$1.pi-sandbox-tmp" "$1"';

const REGULAR_FILE_GUARD = '[ -f "$1" ] || { [ -e "$1" ] || [ -L "$1" ] && exit 4; exit 3; }';

const READ_SCRIPT = `${REGULAR_FILE_GUARD}; head -c "$2" "$1"`;

const REMOVE_SCRIPT = 'rm -f "$1"';

const REMOVE_DIRS_SCRIPT = [
  'root=$1; shift; refused=""; failed=0; set -f',
  'for name in "$@"; do',
  "  dir=$root; linked=0; IFS=/",
  '  for part in $(dirname -- "$name"); do dir=$dir/$part; [ -L "$dir" ] && linked=1; done',
  "  unset IFS",
  '  if [ "$linked" = 1 ]; then refused="$refused $name"; elif ! rm -rf -- "$root/$name"; then failed=1; fi',
  "done",
  '[ -z "$refused" ] || { echo "$refused"; exit 5; }',
  'exit "$failed"',
].join("\n");

const SYMLINKED_EXIT = 5;

const MISSING_EXIT = 3;

const NOT_REGULAR_EXIT = 4;

const READ_TIMEOUT_MS = 5000;

const REMOVE_TIMEOUT_MS = MINUTE_MS;

const CHECKED_FILE_BYTES = MIB;

const guestPath = (name: string) => posix.join(GUEST_PATHS.agentDir, name);

interface ScriptOptions {
  input?: string;
  timeoutMs?: number;
}

const runScript = (
  backend: Backend,
  containerId: string,
  script: string,
  args: string[],
  options: ScriptOptions = {},
) =>
  execCapture(
    backend,
    { containerId, command: ["sh", "-c", script, "sh", ...args], env: {}, workdir: "/" },
    options.input,
    options.timeoutMs,
  );

export const writeVolumeFile = async (
  backend: Backend,
  containerId: string,
  name: string,
  value: JsonObject,
) => {
  const result = await runScript(backend, containerId, WRITE_SCRIPT, [guestPath(name)], {
    input: jsonText(value),
  });

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
  const result = await runScript(backend, containerId, READ_SCRIPT, [guestPath(name), String(maxBytes + 1)], {
    timeoutMs,
  }).catch((error: unknown) => {
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

export const readVolumeFile = async (
  backend: Backend,
  containerId: string,
  name: string,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<VolumeRead> => {
  const text = await readVolumeText(backend, containerId, name, CHECKED_FILE_BYTES, timeoutMs);

  if (text?.trim() === "") {
    return { invalid: false };
  }

  const parsed = parseVolumeText({ name, maxBytes: CHECKED_FILE_BYTES }, text);

  return "value" in parsed ? { value: parsed.value, invalid: false } : { invalid: parsed.notices.length > 0 };
};

export const removeVolumeDirs = async (
  backend: Backend,
  containerId: string,
  names: string[],
  timeoutMs = REMOVE_TIMEOUT_MS,
) => {
  const result = await runScript(backend, containerId, REMOVE_DIRS_SCRIPT, [GUEST_PATHS.agentDir, ...names], {
    timeoutMs,
  }).catch((error: unknown) => {
    throw new LauncherError(
      `could not remove the outdated packages from the sandbox volume: ${errorMessage(error)}`,
    );
  });

  if (result.code === SYMLINKED_EXIT) {
    throw new LauncherError(
      `refused to remove ${result.stdout.trim()} from the sandbox volume: a parent folder is a symbolic link`,
    );
  }

  if (result.code !== 0) {
    throw new LauncherError(
      `could not remove the outdated packages from the sandbox volume (exit ${result.code})`,
    );
  }
};

export const removeVolumeFile = async (backend: Backend, containerId: string, name: string) => {
  const result = await runScript(backend, containerId, REMOVE_SCRIPT, [guestPath(name)]);

  if (result.code !== 0) {
    throw new LauncherError(`${name}: could not remove it from the sandbox volume (exit ${result.code})`);
  }
};
