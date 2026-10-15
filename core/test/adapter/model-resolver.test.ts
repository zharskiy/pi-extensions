import { describe, expect, it } from "vitest";
import { splitModelRequest } from "../../adapter/contract.ts";
import { type CatalogModel, resolveModel } from "../../adapter/model-resolver.ts";
import { catalogModel } from "../helpers/fakes.ts";

const catalog: CatalogModel[] = [
  catalogModel("acme/lyra-4-5", true, { name: "Lyra 4.5 (latest)" }),
  catalogModel("acme/lyra-4-5-20251001", true, { name: "Lyra 4.5" }),
  catalogModel("acme/lyra-5-5", true, { name: "Lyra 5.5", contextWindow: 1_000_000 }),
  catalogModel("acme/vega-5-5", true),
  catalogModel("acme/vega-4-6", true),
  catalogModel("cloudco/us.acme.lyra-9-9-v1:0", false),
  catalogModel("beta/nova-6-luna", true, { cost: { input: 0.1, output: 0.5 } }),
  catalogModel("beta/nova-6-sol", true),
  catalogModel("beta/nova-6.1-sol", true),
  catalogModel("beta/nova-6-astra", true),
  catalogModel("beta/nova-10-sol", true),
];

const resolvedRef = (request: string, models = catalog, preferences = {}) => {
  const resolution = resolveModel(request, models, preferences);

  return resolution.kind === "resolved" ? resolution.model.ref : resolution.kind;
};

describe("model request parsing", () => {
  it("splits a thinking suffix, keeps numeric suffixes and rejects unknown levels", () => {
    expect(splitModelRequest("lyra:low")).toEqual({ name: "lyra", thinking: "low" });
    expect(splitModelRequest("x/lyra-v1:0")).toEqual({ name: "x/lyra-v1:0" });
    expect(splitModelRequest(":high")).toEqual({ name: "", thinking: "high" });
    expect(splitModelRequest("lyra:hgih").error).toContain('invalid thinking level "hgih"');
  });
});

describe("model resolution", () => {
  it("resolves an exact provider/id and an exact id", () => {
    expect(resolvedRef("acme/lyra-4-5")).toBe("acme/lyra-4-5");
    expect(resolvedRef("Beta/Nova-6-Luna")).toBe("beta/nova-6-luna");
    expect(resolvedRef("nova-6.1-sol")).toBe("beta/nova-6.1-sol");
  });

  it("tolerates misspellings and reordered words", () => {
    expect(resolvedRef("lyar")).toBe("acme/lyra-5-5");
    expect(resolvedRef("vgea")).toBe("acme/vega-5-5");
    expect(resolvedRef("nova-sol-6.1")).toBe("beta/nova-6.1-sol");
    expect(resolvedRef("nvoa-6.1-sol")).toBe("beta/nova-6.1-sol");
  });

  it("picks the newest version when none is given, numerically rather than by string order", () => {
    expect(resolvedRef("lyra")).toBe("acme/lyra-5-5");
    expect(resolvedRef("vega")).toBe("acme/vega-5-5");
    expect(resolvedRef("sol")).toBe("beta/nova-10-sol");
  });

  it("prefers the undated alias over a dated snapshot of the same version", () => {
    expect(resolvedRef("lyra-4-5")).toBe("acme/lyra-4-5");
  });

  it("returns ranked candidates instead of guessing across model families", () => {
    const resolution = resolveModel("nova-6", catalog);

    expect(resolution.kind).toBe("ambiguous");
    expect(resolution.kind === "ambiguous" && resolution.candidates.map((choice) => choice.ref)).toEqual([
      "beta/nova-6.1-sol",
      "beta/nova-6-luna",
      "beta/nova-6-astra",
    ]);
    expect(resolution.kind === "ambiguous" && resolution.candidates[1]).toEqual({
      ref: "beta/nova-6-luna",
      contextWindow: 200_000,
      cost: { input: 0.1, output: 0.5 },
    });
  });

  it("returns unknown with close suggestions when nothing matches", () => {
    const resolution = resolveModel("zorbo-ultra", catalog);

    expect(resolution).toMatchObject({ kind: "unknown", withoutCredentials: [] });
    expect(resolveModel("lunna-6", catalog)).toMatchObject({
      kind: "resolved",
      model: { ref: "beta/nova-6-luna" },
    });
  });

  it("never resolves to a provider without credentials", () => {
    const locked = catalog.map((model) =>
      model.provider === "acme" ? { ...model, authenticated: false } : model,
    );

    const lyra = resolveModel("lyra", locked);

    expect(lyra.kind).toBe("unknown");
    expect(lyra.kind === "unknown" && lyra.withoutCredentials.map((choice) => choice.ref)).toEqual([
      "cloudco/us.acme.lyra-9-9-v1:0",
      "acme/lyra-5-5",
      "acme/lyra-4-5",
      "acme/lyra-4-5-20251001",
    ]);
    expect(resolveModel("acme/lyra-5-5", locked)).toMatchObject({
      kind: "invalid",
      error: expect.stringContaining('provider "acme" has no credentials'),
    });
    expect(resolveModel("acme/lyra", locked)).toMatchObject({ kind: "invalid" });
    expect(resolvedRef("lyra")).toBe("acme/lyra-5-5");
  });

  it("breaks ties between providers by the session provider, then the default provider", () => {
    const shared = [
      catalogModel("zeta/nova-6-luna"),
      catalogModel("beta/nova-6-luna"),
      catalogModel("alpha/nova-6-luna"),
    ];

    expect(resolvedRef("nova-6-luna", shared)).toBe("alpha/nova-6-luna");
    expect(resolvedRef("nova-6-luna", shared, { defaultProvider: "zeta" })).toBe("zeta/nova-6-luna");
    expect(resolvedRef("luna", shared, { sessionProvider: "beta", defaultProvider: "zeta" })).toBe(
      "beta/nova-6-luna",
    );
  });

  it("prefers a newer version over the session provider", () => {
    const models = [catalogModel("beta/nova-6-luna"), catalogModel("other/nova-7-luna")];

    expect(resolvedRef("luna", models, { sessionProvider: "beta" })).toBe("other/nova-7-luna");
  });
});
