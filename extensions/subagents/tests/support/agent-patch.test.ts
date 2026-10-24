import { describe, expect, it } from "vitest";
import { modelForGroup, patchAgentFile, shippedGroup } from "./agent-patch.ts";

const SHIPPED = [
  "---",
  "name: planner",
  "model: a/lead:high",
  "limit: 120000",
  "---",
  "Shipped prompt.",
  "",
].join("\n");

const models = { lead: "live/lead:high", chore: "live/chore:low" };

describe("patchAgentFile", () => {
  it("forces the live model and limit on a lead and keeps the shipped body", () => {
    const text = patchAgentFile(SHIPPED, {
      name: "planner",
      group: "leads",
      patch: { from: "planner" },
      models,
    });

    expect(text).toBe(
      ["---", "name: planner", "model: live/lead:high", "limit: 20000", "---", "Shipped prompt.", ""].join(
        "\n",
      ),
    );
  });

  it("lets fields override the limit and a body replace the prompt", () => {
    const text = patchAgentFile(SHIPPED, {
      name: "lead",
      group: "leads",
      patch: { from: "planner", fields: { limit: "120000" }, body: "\nNew prompt.\n\n" },
      models,
    });

    expect(text).toBe(
      ["---", "name: lead", "model: live/lead:high", "limit: 120000", "---", "New prompt.", ""].join("\n"),
    );
  });

  it("keeps a chore's shipped limit", () => {
    const text = patchAgentFile(SHIPPED.replace("planner", "scout"), {
      name: "scout",
      group: "chores",
      patch: { from: "scout" },
      models,
    });

    expect(text).toBe(
      ["---", "name: scout", "model: live/chore:low", "limit: 120000", "---", "Shipped prompt.", ""].join(
        "\n",
      ),
    );
  });

  it("gives chores the chore model and leads the lead model", () => {
    expect(modelForGroup("chores", models)).toBe("live/chore:low");
    expect(modelForGroup("leads", models)).toBe("live/lead:high");
  });

  it("finds the shipped group and refuses a name under both", () => {
    expect(shippedGroup("scout", (group) => group === "chores")).toBe("chores");
    expect(() => shippedGroup("twin", () => true)).toThrow("both leads and chores");
    expect(() => shippedGroup("nobody", () => false)).toThrow("no shipped agent named nobody");
  });
});
