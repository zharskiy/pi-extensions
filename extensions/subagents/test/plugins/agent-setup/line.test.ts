import { describe, expect, it } from "vitest";
import { type LineCheck, parseSetupLine } from "../../../src/plugins/agent-setup/line.ts";

const check = (extra: Partial<LineCheck> = {}): LineCheck => ({
  agents: ["scout"],
  skills: ["docs"],
  defaultScope: "project",
  resolveModel: (model) =>
    model.startsWith("acme/") ? { ref: model } : { error: `model "${model}": unknown` },
  ...extra,
});

describe("/agents setup one-line parser", () => {
  it("parses inherit and none and keeps the last scope", () => {
    expect(parseSetupLine("scout model=inherit skills=none scope=user", check())).toEqual({
      change: { name: "scout", patch: { model: "inherit", skills: [] } },
      scope: "user",
    });
  });

  it("resolves the model, splits its thinking suffix and uses the default scope", () => {
    expect(parseSetupLine("scout model=acme/one:high skills=docs", check({ defaultScope: "user" }))).toEqual({
      change: { name: "scout", patch: { model: "acme/one", thinking: "high", skills: ["docs"] } },
      scope: "user",
    });
  });

  it("returns one error naming every bad pair", () => {
    const parsed = parseSetupLine("scout model=other/x thinking=extreme skills=ghost color=blue", check());

    expect(parsed).toEqual({
      error: [
        'model "other/x": unknown',
        "thinking must be one of off, minimal, low, medium, high, xhigh, max",
        "skills names unknown skill(s) ghost (loaded skills: docs)",
        '"color=blue" is not key=value with a key of model, thinking, skills, scope',
      ].join("; "),
    });
  });

  it("returns a usage error without pairs or for an unknown agent", () => {
    expect(parseSetupLine("scout", check())).toHaveProperty("error");
    expect(parseSetupLine("ghost thinking=low", check())).toEqual({
      error: 'no agent named "ghost" (agents: scout)',
    });
  });
});
