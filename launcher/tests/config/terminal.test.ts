import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { mergeConfig } from "../../config/merge.ts";
import { configProblem } from "../../config/validate.ts";

describe("terminal.clipboard", () => {
  it("is on by default", () => {
    const { config, sources } = mergeConfig(defaultConfig(), {});

    expect(config.terminal.clipboard).toBe(true);
    expect(sources["terminal.clipboard"]).toBe("default");
  });

  it("lets the config turn it off", () => {
    const { config, sources } = mergeConfig(defaultConfig(), { terminal: { clipboard: false } });

    expect(config.terminal.clipboard).toBe(false);
    expect(sources["terminal.clipboard"]).toBe("config");
  });

  it("must be true or false and takes no other key", () => {
    expect(configProblem({ terminal: { clipboard: "yes" } })).toBe(
      "config: terminal.clipboard must be true or false",
    );
    expect(configProblem({ terminal: { paste: true } })).toBe("config: terminal.paste is not a known key");
  });
});
