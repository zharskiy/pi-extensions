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
    host.sendMessage({ customType: "x", text: "idle", display: true }, { after: "afterRun" });
    host.idle = false;
    host.sendMessage({ customType: "x", text: "later", display: true }, { after: "afterRun" });
    host.sendMessage({ customType: "x", text: "sooner", display: true }, { after: "afterTurn" });

    expect(host.messages.map((entry) => [entry.message.text, entry.after, entry.delivery])).toEqual([
      ["idle", "afterRun", "run"],
      ["later", "afterRun", "followUp"],
      ["sooner", "afterTurn", "steer"],
    ]);
    expect(host.hidden).toEqual([]);
  });
});
