import { type FileHandle, open } from "node:fs/promises";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";

const GUARDED = Symbol.for("pi-extensions.aborted-read-guard");

type CreateReadStream = FileHandle["createReadStream"];

type GuardablePrototype = FileHandle & { [GUARDED]?: CreateReadStream };

const probeFiles = [() => fileURLToPath(import.meta.url), () => process.execPath, () => devNull];

const ignoreError = () => undefined;

let fileHandlePrototype: GuardablePrototype | undefined;

const openProbe = () =>
  probeFiles.reduce<Promise<FileHandle>>(
    (opened, probeFile) => opened.catch(() => open(probeFile(), "r")),
    Promise.reject(new Error("no probe file")),
  );

const probePrototype = async (): Promise<GuardablePrototype> => {
  const handle = await openProbe();

  try {
    return Object.getPrototypeOf(handle);
  } finally {
    await handle.close();
  }
};

const guardPrototype = (prototype: GuardablePrototype) => {
  if (Object.hasOwn(prototype, GUARDED)) {
    return;
  }

  const unguarded = prototype.createReadStream;

  prototype.createReadStream = function createReadStream(
    this: FileHandle,
    ...args: Parameters<CreateReadStream>
  ) {
    const stream = unguarded.apply(this, args);

    if (args[0]?.signal?.aborted) {
      stream.on("error", ignoreError);
    }

    return stream;
  };

  Object.defineProperty(prototype, GUARDED, { value: unguarded, configurable: true });
};

const installGuard = async () => {
  fileHandlePrototype ??= await probePrototype();

  guardPrototype(fileHandlePrototype);
};

export const guardAbortedReads = (): Promise<void> => installGuard().catch(() => undefined);
