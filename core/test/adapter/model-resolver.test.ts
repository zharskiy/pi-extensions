import { describe, expect, it } from "vitest";
import { splitModelRequest } from "../../adapter/contract.ts";
import { type CatalogModel, resolveModel } from "../../adapter/model-resolver.ts";
import { catalogModel } from "../helpers/fakes.ts";

const catalog: CatalogModel[] = [
  catalogModel("anthropic/claude-haiku-4-5", true, { name: "Claude Haiku 4.5 (latest)" }),
  catalogModel("anthropic/claude-haiku-4-5-20251001", true, { name: "Claude Haiku 4.5" }),
  catalogModel("anthropic/claude-haiku-5-5", true, { name: "Claude Haiku 5.5", contextWindow: 1_000_000 }),
  catalogModel("anthropic/claude-sonnet-5-5", true),
  catalogModel("anthropic/claude-sonnet-4-6", true),
  catalogModel("amazon-bedrock/us.anthropic.claude-haiku-9-9-v1:0", false),
  catalogModel("openai/gpt-6-luna", true, { cost: { input: 0.1, output: 0.5 } }),
  catalogModel("openai/gpt-6-sol", true),
  catalogModel("openai/gpt-6.1-sol", true),
  catalogModel("openai/gpt-6-astra", true),
  catalogModel("openai/gpt-10-sol", true),
];

const resolvedRef = (request: string, models = catalog, preferences = {}) => {
  const resolution = resolveModel(request, models, preferences);

  return resolution.kind === "resolved" ? resolution.model.ref : resolution.kind;
};

describe("model request parsing", () => {
  it("splits a thinking suffix, keeps numeric suffixes and rejects unknown levels", () => {
    expect(splitModelRequest("haiku:low")).toEqual({ name: "haiku", thinking: "low" });
    expect(splitModelRequest("x/claude-v1:0")).toEqual({ name: "x/claude-v1:0" });
    expect(splitModelRequest(":high")).toEqual({ name: "", thinking: "high" });
    expect(splitModelRequest("haiku:hgih").error).toContain('invalid thinking level "hgih"');
  });
});

describe("model resolution", () => {
  it("resolves an exact provider/id and an exact id", () => {
    expect(resolvedRef("anthropic/claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
    expect(resolvedRef("OpenAI/GPT-6-Luna")).toBe("openai/gpt-6-luna");
    expect(resolvedRef("gpt-6.1-sol")).toBe("openai/gpt-6.1-sol");
  });

  it("tolerates misspellings and reordered words", () => {
    expect(resolvedRef("hiaku")).toBe("anthropic/claude-haiku-5-5");
    expect(resolvedRef("sonet")).toBe("anthropic/claude-sonnet-5-5");
    expect(resolvedRef("gpt-sol-6.1")).toBe("openai/gpt-6.1-sol");
    expect(resolvedRef("gtp-6.1-sol")).toBe("openai/gpt-6.1-sol");
  });

  it("picks the newest version when none is given, numerically rather than by string order", () => {
    expect(resolvedRef("haiku")).toBe("anthropic/claude-haiku-5-5");
    expect(resolvedRef("sonnet")).toBe("anthropic/claude-sonnet-5-5");
    expect(resolvedRef("sol")).toBe("openai/gpt-10-sol");
  });

  it("prefers the undated alias over a dated snapshot of the same version", () => {
    expect(resolvedRef("haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
  });

  it("returns ranked candidates instead of guessing across model families", () => {
    const resolution = resolveModel("gpt-6", catalog);

    expect(resolution.kind).toBe("ambiguous");
    expect(resolution.kind === "ambiguous" && resolution.candidates.map((choice) => choice.ref)).toEqual([
      "openai/gpt-6.1-sol",
      "openai/gpt-6-luna",
      "openai/gpt-6-astra",
    ]);
    expect(resolution.kind === "ambiguous" && resolution.candidates[1]).toEqual({
      ref: "openai/gpt-6-luna",
      contextWindow: 200_000,
      cost: { input: 0.1, output: 0.5 },
    });
  });

  it("returns unknown with close suggestions when nothing matches", () => {
    const resolution = resolveModel("gemini-ultra", catalog);

    expect(resolution).toMatchObject({ kind: "unknown", withoutCredentials: [] });
    expect(resolveModel("lunna-6", catalog)).toMatchObject({
      kind: "resolved",
      model: { ref: "openai/gpt-6-luna" },
    });
  });

  it("never resolves to a provider without credentials", () => {
    const locked = catalog.map((model) =>
      model.provider === "anthropic" ? { ...model, authenticated: false } : model,
    );

    const haiku = resolveModel("haiku", locked);

    expect(haiku.kind).toBe("unknown");
    expect(haiku.kind === "unknown" && haiku.withoutCredentials.map((choice) => choice.ref)).toEqual([
      "amazon-bedrock/us.anthropic.claude-haiku-9-9-v1:0",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-haiku-4-5-20251001",
    ]);
    expect(resolveModel("anthropic/claude-haiku-5-5", locked)).toMatchObject({
      kind: "invalid",
      error: expect.stringContaining('provider "anthropic" has no credentials'),
    });
    expect(resolveModel("anthropic/haiku", locked)).toMatchObject({ kind: "invalid" });
    expect(resolvedRef("haiku")).toBe("anthropic/claude-haiku-5-5");
  });

  it("breaks ties between providers by the session provider, then the default provider", () => {
    const shared = [
      catalogModel("zeta/gpt-6-luna"),
      catalogModel("openai/gpt-6-luna"),
      catalogModel("azure/gpt-6-luna"),
    ];

    expect(resolvedRef("gpt-6-luna", shared)).toBe("azure/gpt-6-luna");
    expect(resolvedRef("gpt-6-luna", shared, { defaultProvider: "zeta" })).toBe("zeta/gpt-6-luna");
    expect(resolvedRef("luna", shared, { sessionProvider: "openai", defaultProvider: "zeta" })).toBe(
      "openai/gpt-6-luna",
    );
  });

  it("prefers a newer version over the session provider", () => {
    const models = [catalogModel("openai/gpt-6-luna"), catalogModel("other/gpt-7-luna")];

    expect(resolvedRef("luna", models, { sessionProvider: "openai" })).toBe("other/gpt-7-luna");
  });
});
