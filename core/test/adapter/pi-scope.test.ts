import { describe, expect, it } from "vitest";
import { childScope, insideChildSession } from "../../../pi-adapter/runtime/pi-scope.ts";

type ScopeModule = typeof import("../../../pi-adapter/runtime/pi-scope.ts");

const loadCopy = async (tag: string): Promise<ScopeModule> =>
  import(new URL(`../../../pi-adapter/runtime/pi-scope.ts?copy=${tag}`, import.meta.url).href);

describe("child scope", () => {
  it("is outside a child session unless run inside the scope", async () => {
    expect(insideChildSession()).toBe(false);

    const inside = await childScope.run({ agentId: "a1" }, async () => insideChildSession());

    expect(inside).toBe(true);
  });

  it("shares one store across separately loaded copies of the module", async () => {
    const copy = await loadCopy("second");

    expect(copy).not.toBe(await import("../../../pi-adapter/runtime/pi-scope.ts"));
    expect(copy.childScope).toBe(childScope);

    const seen = await copy.childScope.run({ agentId: "a2" }, async () => [
      insideChildSession(),
      childScope.getStore()?.agentId,
    ]);

    expect(seen).toEqual([true, "a2"]);
    expect(copy.insideChildSession()).toBe(false);
  });
});
