import { describe, expect, it } from "vitest";
import { createBus } from "../bus.ts";

type Events = { changed: { id: string }; closed: number };

describe("bus", () => {
  it("isolates listener errors and supports unsubscribe", () => {
    const errors: unknown[] = [];
    const bus = createBus<Events>((error) => errors.push(error));
    const seen: string[] = [];

    bus.on("changed", () => {
      throw new Error("boom");
    });

    const off = bus.on("changed", ({ id }) => seen.push(id));

    bus.emit("changed", { id: "a" });
    off();
    bus.emit("changed", { id: "b" });

    expect(seen).toEqual(["a"]);
    expect(errors).toHaveLength(2);
  });

  it("delivers each event only to its own listeners, as they were when it was emitted", () => {
    const bus = createBus<Events>();
    const seen: string[] = [];

    bus.on("closed", (count) => {
      seen.push(`closed ${count}`);
      bus.on("closed", () => seen.push("late"));
    });

    bus.emit("changed", { id: "x" });
    bus.emit("closed", 1);

    expect(seen).toEqual(["closed 1"]);
  });
});
