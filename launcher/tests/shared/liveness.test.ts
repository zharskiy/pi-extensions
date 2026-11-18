import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startOf = vi.hoisted(() => ({
  fail: false,
  failure: "tool" as "tool" | "process",
  calls: [] as number[],
}));

vi.mock("../../shared/process-start.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/process-start.ts")>();

  const readProcessStart = async (pid: number) => {
    startOf.calls.push(pid);

    return startOf.fail ? { failed: startOf.failure } : actual.readProcessStart(pid);
  };

  return {
    readProcessStart,
    processStart: async (pid: number) => {
      const reading = await readProcessStart(pid);

      return "start" in reading ? reading.start : undefined;
    },
  };
});

const load = async () => {
  vi.resetModules();

  return import("../../shared/liveness.ts");
};

beforeEach(() => {
  startOf.fail = false;
  startOf.failure = "tool";
  startOf.calls = [];
});

afterEach(() => {
  vi.resetModules();
});

const sleeper = async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);

  await once(child, "spawn");

  return child;
};

describe("isLive", () => {
  it("counts a running pid as live when the start-time tool itself failed to run", async () => {
    const { bootTime, isLive } = await load();
    const holder = await sleeper();

    try {
      startOf.fail = true;

      expect(await isLive({ pid: holder.pid, boot: bootTime(), start: "Mon-Nov-9-00:00:00-2026" })).toBe(
        true,
      );
    } finally {
      holder.kill();
    }
  });

  it("counts a running pid as dead when its start time is not obtainable for that pid", async () => {
    const { bootTime, isLive } = await load();
    const holder = await sleeper();

    try {
      startOf.fail = true;
      startOf.failure = "process";

      expect(await isLive({ pid: holder.pid, boot: bootTime(), start: "Mon-Nov-9-00:00:00-2026" })).toBe(
        false,
      );
    } finally {
      holder.kill();
    }
  });

  it("still counts a running pid with another recorded start time as dead", async () => {
    const { bootTime, isLive } = await load();
    const holder = await sleeper();

    try {
      expect(await isLive({ pid: holder.pid, boot: bootTime(), start: "Thu-Jan-1-00:00:00-1970" })).toBe(
        false,
      );
    } finally {
      holder.kill();
    }
  });

  it("judges its own mark without reading its start time again", async () => {
    const { isLive, processMark } = await load();
    const mark = await processMark();

    startOf.calls = [];

    expect(await isLive(mark)).toBe(true);
    expect(startOf.calls).toEqual([]);
  });
});

describe("processMark", () => {
  it("refuses to make a mark when its own start time cannot be read, and retries the read next time", async () => {
    const { processMark } = await load();

    startOf.fail = true;

    await expect(processMark()).rejects.toThrow(`cannot read the start time of process ${process.pid}`);

    startOf.fail = false;

    expect(await processMark()).toMatchObject({ pid: process.pid, start: expect.stringMatching(/.+/) });
  });
});

describe("readProcessStart", () => {
  it("reads a live pid and reports a pid without a process as a process failure, not a tool failure", async () => {
    const { readProcessStart } = await vi.importActual<typeof import("../../shared/process-start.ts")>(
      "../../shared/process-start.ts",
    );
    const holder = await sleeper();

    try {
      expect(await readProcessStart(holder.pid ?? 0)).toEqual({ start: expect.stringMatching(/.+/) });
    } finally {
      holder.kill();
    }

    await once(holder, "exit");

    expect(await readProcessStart(holder.pid ?? 0)).toEqual({ failed: "process" });
  });
});
