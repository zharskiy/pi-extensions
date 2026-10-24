import { describe, expect, it } from "vitest";
import { settleWithin } from "../../../pi-adapter/index.ts";

describe("settleWithin", () => {
  it("resolves when the promise settles, even by rejecting", async () => {
    await expect(settleWithin(Promise.resolve(), 1_000)).resolves.toBeUndefined();
    await expect(settleWithin(Promise.reject(new Error("x")), 1_000)).resolves.toBeUndefined();
  });

  it("resolves after the wait when the promise never settles", async () => {
    await expect(settleWithin(new Promise(() => {}), 10)).resolves.toBeUndefined();
  });
});
