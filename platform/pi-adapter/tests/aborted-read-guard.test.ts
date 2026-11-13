import { execFile } from "node:child_process";
import { type FileHandle, open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPiExtension } from "../index.ts";
import { guardAbortedReads } from "../runtime/aborted-read-guard.ts";
import { childScope } from "../runtime/child-scope.ts";

const GUARDED = Symbol.for("pi-extensions.aborted-read-guard");

const guardUrl = new URL("../runtime/aborted-read-guard.ts", import.meta.url).href;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const run = promisify(execFile);

type GuardModule = typeof import("../runtime/aborted-read-guard.ts");

const loadCopy = async (tag: string): Promise<GuardModule> =>
  import(new URL(`../runtime/aborted-read-guard.ts?copy=${tag}`, import.meta.url).href);

type GuardablePrototype = FileHandle & { [GUARDED]?: FileHandle["createReadStream"] };

const fileHandlePrototype = async (): Promise<GuardablePrototype> => {
  const handle = await open(process.execPath, "r");
  const prototype = Object.getPrototypeOf(handle);

  await handle.close();

  return prototype;
};

const fakePi = () =>
  ({
    on: () => undefined,
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
    getCommands: () => [],
    getActiveTools: () => [],
    getAllTools: () => [],
    registerEntryRenderer: () => undefined,
  }) as never;

const abortedSignal = () => {
  const controller = new AbortController();

  controller.abort();

  return controller.signal;
};

const drain = async (stream: Readable) => (await stream.toArray()).length;

const afterDeferredEmit = () => new Promise((resolve) => setTimeout(resolve, 50));

const hazardScript = `
import { open } from "node:fs/promises";
process.on("uncaughtException", (error) => { console.log("uncaught " + error.name); process.exit(1); });
const guard = process.argv[1];
if (guard) { await (await import(guard)).guardAbortedReads(); }
const handle = await open(process.execPath, "r");
const controller = new AbortController();
controller.abort();
const outcome = await Array.fromAsync(handle.createReadStream({ signal: controller.signal, autoClose: false })).then(() => "read", (error) => error.name);
await handle.close();
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("survived " + outcome);
`;

const piReadScript = `
import { open } from "node:fs/promises";
process.on("uncaughtException", (error) => { console.log("uncaught " + error.name); process.exit(1); });
const guard = process.argv[1];
if (guard) { await (await import(guard)).guardAbortedReads(); }
const { createReadToolDefinition } = await import("@earendil-works/pi-coding-agent");
const controller = new AbortController();
const probe = await open(process.execPath, "r");
const prototype = Object.getPrototypeOf(probe);
await probe.close();
const stat = prototype.stat;
prototype.stat = function (...args) { controller.abort(); return stat.apply(this, args); };
const cwd = process.cwd();
const read = createReadToolDefinition(cwd);
const paths = ["package.json", "README.md", "ARCHITECTURE.md"];
const results = await Promise.allSettled(paths.map((path) => read.execute("t", { path }, controller.signal, undefined, { cwd })));
await new Promise((resolve) => setTimeout(resolve, 100));
console.log("survived " + results.map((result) => result.status).join(","));
`;

const runScript = async (script: string, guard?: string) => {
  const args = ["--input-type=module", "-e", script, ...(guard ? [guard] : [])];

  return run(process.execPath, args, { cwd: repoRoot }).then(
    ({ stdout }) => ({ code: 0, stdout: stdout.trim() }),
    (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout.trim() }),
  );
};

describe("guardAbortedReads", () => {
  let prototype: GuardablePrototype;
  let unguarded: FileHandle["createReadStream"];
  let unguardedDescriptor: PropertyDescriptor | undefined;

  const unguard = () => {
    const original = prototype[GUARDED];

    if (original) {
      prototype.createReadStream = original;

      Reflect.deleteProperty(prototype, GUARDED);
    }
  };

  beforeAll(async () => {
    prototype = await fileHandlePrototype();
  });

  beforeEach(() => {
    unguard();

    unguarded = prototype.createReadStream;
    unguardedDescriptor = Object.getOwnPropertyDescriptor(prototype, "createReadStream");
  });

  afterAll(unguard);

  it("lets a read on an aborted signal reject with the AbortError and absorbs the stream's late error", async () => {
    await guardAbortedReads();

    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);

    process.on("uncaughtException", record);

    const handle = await open(process.execPath, "r");
    const stream = handle.createReadStream({ signal: abortedSignal(), autoClose: false });

    await expect(drain(stream)).rejects.toMatchObject({ name: "AbortError" });

    await handle.close();

    await afterDeferredEmit();

    process.off("uncaughtException", record);

    expect(uncaught).toEqual([]);
  });

  it("reads normally on a live signal and adds no error listener to its stream", async () => {
    const errorListeners = async () => {
      const handle = await open(fileURLToPath(guardUrl), "r");
      const stream = handle.createReadStream({ signal: new AbortController().signal, autoClose: false });
      const listeners = stream.listenerCount("error");

      await expect(drain(stream)).resolves.toBeGreaterThan(0);

      await handle.close();

      return listeners;
    };

    const baseline = await errorListeners();

    await guardAbortedReads();

    await expect(errorListeners()).resolves.toBe(baseline);
  });

  it("still hands the error to a listener of the aborted stream", async () => {
    await guardAbortedReads();

    const handle = await open(process.execPath, "r");
    const stream = handle.createReadStream({ signal: abortedSignal(), autoClose: false });
    const received = new Promise((resolve) => stream.once("error", resolve));

    await handle.close();

    await expect(received).resolves.toMatchObject({ name: "AbortError" });
  });

  it("keeps the wrapped method's name, length and property flags", async () => {
    await guardAbortedReads();

    const guarded = prototype.createReadStream;

    expect(guarded).not.toBe(unguarded);
    expect(guarded.name).toBe(unguarded.name);
    expect(guarded.length).toBe(unguarded.length);
    expect(Object.getOwnPropertyDescriptor(prototype, "createReadStream")).toEqual({
      ...unguardedDescriptor,
      value: guarded,
    });
  });

  it("wraps the prototype once, however many times or adapter copies install it", async () => {
    await guardAbortedReads();

    const guarded = prototype.createReadStream;

    await guardAbortedReads();

    await (await loadCopy("second")).guardAbortedReads();

    expect(prototype.createReadStream).toBe(guarded);
    expect(prototype[GUARDED]).toBe(unguarded);
  });

  it("removes a crash this Node really has: an unguarded aborted read dies, a guarded one survives", async () => {
    const unguardedRun = await runScript(hazardScript);
    const guardedRun = await runScript(hazardScript, guardUrl);

    expect(unguardedRun).toEqual({ code: 1, stdout: "uncaught AbortError" });
    expect(guardedRun).toEqual({ code: 0, stdout: "survived AbortError" });
  });

  it("keeps pi's read tool from crashing the process when its signal aborts between stat and stream", async () => {
    const unguardedRun = await runScript(piReadScript);
    const guardedRun = await runScript(piReadScript, guardUrl);

    expect(unguardedRun).toEqual({ code: 1, stdout: "uncaught AbortError" });
    expect(guardedRun).toEqual({ code: 0, stdout: "survived rejected,rejected,rejected" });
  });

  it("returns the guard's install from the factory of a main session, installed once it resolves", async () => {
    const factory = createPiExtension(() => undefined, { root: "/ext", namespace: "test" });
    const loading = factory(fakePi());

    expect(loading).toBeInstanceOf(Promise);

    await loading;

    expect(prototype[GUARDED]).toBe(unguarded);
  });

  it("returns the guard's install from the factory inside a child session, installed once it resolves", async () => {
    const factory = createPiExtension(() => undefined, { root: "/ext", namespace: "test" });
    const loading = childScope.run({ agentId: "a" }, () => factory(fakePi()));

    expect(loading).toBeInstanceOf(Promise);

    await loading;

    expect(prototype[GUARDED]).toBe(unguarded);
  });
});
