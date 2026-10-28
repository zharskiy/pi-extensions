import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../test/framework/index.ts";
import { createModelDefault } from "../api/plugin.ts";

const setup = () => {
  const host = createFakeHost();

  createModelDefault(host);
  host.start();

  return host;
};

describe("model default", () => {
  it("saves every chosen model as the default, the latest last", async () => {
    const host = setup();

    await host.selectModel("acme/alpha");
    await host.selectModel("acme/beta");

    expect(host.savedDefaults).toEqual(["acme/alpha", "acme/beta"]);
    expect(host.notices).toEqual([]);
  });

  it("warns when the default cannot be saved", async () => {
    const host = setup();

    host.saveFailure = "settings.json is locked";

    await host.selectModel("acme/alpha");

    expect(host.savedDefaults).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: "pi-model-default: acme/alpha is not saved as the default model: settings.json is locked",
        level: "warning",
      },
    ]);
  });

  it("saves every chosen thinking level as the default, the latest last", async () => {
    const host = setup();

    await host.selectThinking("high");
    await host.selectThinking("low");

    expect(host.savedThinkingLevels).toEqual(["high", "low"]);
    expect(host.notices).toEqual([]);
  });

  it("warns when the thinking level cannot be saved", async () => {
    const host = setup();

    host.saveFailure = "settings.json is locked";

    await host.selectThinking("high");

    expect(host.savedThinkingLevels).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: "pi-model-default: high is not saved as the default thinking level: settings.json is locked",
        level: "warning",
      },
    ]);
  });
});
