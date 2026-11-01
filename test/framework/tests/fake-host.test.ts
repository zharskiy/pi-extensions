import { describe, expect, it } from "vitest";
import { createFakeHost, createTurnScope, hiddenMessageTexts } from "../index.ts";

describe("createTurnScope", () => {
  const deferred = () => {
    const box: { resolve: () => void } = { resolve: () => {} };
    const promise = new Promise<void>((resolve) => {
      box.resolve = resolve;
    });

    return { promise, resolve: () => box.resolve() };
  };

  it("keeps the host busy until the last overlapping run returns and settles once", async () => {
    const host = createFakeHost();
    const settled: number[] = [];

    host.onIdle(() => settled.push(1));

    const turn = createTurnScope(host);
    const first = deferred();
    const second = deferred();
    const runs = [turn(() => first.promise), turn(() => second.promise)];

    expect(host.idle).toBe(false);

    first.resolve();
    await runs[0];

    expect(host.idle).toBe(false);
    expect(settled).toEqual([]);

    second.resolve();
    await runs[1];

    expect(host.idle).toBe(true);
    expect(settled).toEqual([1]);
  });

  it("goes busy again for a second turn after the first settled and settles again", async () => {
    const host = createFakeHost();
    const settled: number[] = [];

    host.onIdle(() => settled.push(settled.length + 1));

    const turn = createTurnScope(host);

    await turn(async () => undefined);

    expect(host.idle).toBe(true);
    expect(settled).toEqual([1]);

    const next = deferred();
    const run = turn(() => next.promise);

    expect(host.idle).toBe(false);
    expect(settled).toEqual([1]);

    next.resolve();
    await run;

    expect(host.idle).toBe(true);
    expect(settled).toEqual([1, 2]);
  });

  it("settles and rethrows when the run fails", async () => {
    const host = createFakeHost();
    const turn = createTurnScope(host);

    await expect(turn(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(host.idle).toBe(true);
  });
});

describe("hiddenMessageTexts", () => {
  it("lists the text of every hidden message in order", () => {
    const host = createFakeHost();

    host.start();
    host.sendHiddenMessage({ customType: "x", text: "first" });
    host.sendHiddenMessage({ customType: "x", text: "second" });

    expect(hiddenMessageTexts(host)).toEqual(["first", "second"]);
  });
});

describe("sendMessage", () => {
  it("records displayed messages with their timing and the delivery the host would use", () => {
    const host = createFakeHost();

    host.start();
    host.sendMessage({ customType: "x", text: "idle" });
    host.idle = false;
    host.sendMessage({ customType: "x", text: "later" });

    expect(host.messages.map((entry) => [entry.message.text, entry.delivery])).toEqual([
      ["idle", "run"],
      ["later", "followUp"],
    ]);
    expect(host.hidden).toEqual([]);
  });
});

describe("renderEntry", () => {
  it("draws an entry after the pad at the width left, and a flush one at the full width, both given the pad", () => {
    const host = createFakeHost();
    const sized = (_data: unknown, width: number, _expanded: boolean, _theme: unknown, pad: number) => [
      `${width}:${pad}`,
    ];

    host.registerEntryRenderer("x:padded", sized);
    host.registerEntryRenderer("x:flush", sized, { flush: true });

    expect(host.renderEntry("x:padded", {}, { width: 10, pad: 2 })).toEqual(["  8:2"]);
    expect(host.renderEntry("x:flush", {}, { width: 10, pad: 2 })).toEqual(["10:2"]);
    expect(host.renderEntry("x:padded", {}, { width: 10 })).toEqual(["10:0"]);
  });
});
