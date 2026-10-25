import { describe, expect, it } from "vitest";
import { createPiExtension } from "../index.ts";
import { childScope, insideChildSession } from "../runtime/child-scope.ts";

type ScopeModule = typeof import("../runtime/child-scope.ts");

const fakePi = () => {
  const events: string[] = [];
  const pi = {
    on: (event: string) => {
      events.push(event);
    },
    getSettings: () => ({}),
    getThinkingLevel: () => "off",
    getCommands: () => [],
    getActiveTools: () => [],
    getAllTools: () => [],
  };

  return { pi: pi as never, events };
};

const loadCopy = async (tag: string): Promise<ScopeModule> =>
  import(new URL(`../runtime/child-scope.ts?copy=${tag}`, import.meta.url).href);

describe("child scope", () => {
  it("is outside a child session unless run inside the scope", async () => {
    expect(insideChildSession()).toBe(false);

    const inside = await childScope.run({ agentId: "a1" }, async () => insideChildSession());

    expect(inside).toBe(true);
  });

  it("shares one store across separately loaded copies of the module", async () => {
    const copy = await loadCopy("second");

    expect(copy).not.toBe(await import("../runtime/child-scope.ts"));
    expect(copy.childScope).toBe(childScope);

    const seen = await copy.childScope.run({ agentId: "a2" }, async () => [
      insideChildSession(),
      childScope.getStore()?.agentId,
    ]);

    expect(seen).toEqual([true, "a2"]);
    expect(copy.insideChildSession()).toBe(false);
  });

  it("never boots an adapter extension inside a child session", async () => {
    const boots: string[] = [];
    const factory = createPiExtension(
      () => {
        boots.push("boot");
      },
      { root: "/ext", namespace: "test-ext" },
    );
    const child = fakePi();

    await childScope.run({ agentId: "a" }, async () => factory(child.pi));

    expect(boots).toEqual([]);
    expect(child.events).toEqual([]);

    const parent = fakePi();

    await factory(parent.pi);

    expect(boots).toEqual(["boot"]);
    expect(parent.events).not.toEqual([]);
  });
});
