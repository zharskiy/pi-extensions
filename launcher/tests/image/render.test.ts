import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "../../config/index.ts";
import { renderAuthJson, renderModelsJson } from "../../image/render.ts";

const gateway: GatewayConfig = {
  url: "https://gateway.example.com/",
  authHeader: "x-api-key",
  placeholder: "pi-sandbox-placeholder",
  providers: [
    { id: "gateway", apiKind: "example-messages" },
    { id: "relay", apiKind: "example-completions" },
  ],
};

describe("renderModelsJson", () => {
  it("points every provider at the gateway with the placeholder key and the configured api", () => {
    expect(renderModelsJson(gateway)).toEqual({
      providers: {
        gateway: {
          baseUrl: "https://gateway.example.com/gateway",
          apiKey: "pi-sandbox-placeholder",
          api: "example-messages",
          models: [],
        },
        relay: {
          baseUrl: "https://gateway.example.com/relay",
          apiKey: "pi-sandbox-placeholder",
          api: "example-completions",
          models: [],
        },
      },
    });
  });

  it("keeps a provider's own base url", () => {
    const custom = {
      ...gateway,
      providers: [{ id: "regional", apiKind: "example-messages", baseUrl: "https://b.example.com/v1" }],
    };

    expect(renderModelsJson(custom).providers.regional?.baseUrl).toBe("https://b.example.com/v1");
  });

  it("renders no providers without a gateway", () => {
    expect(renderModelsJson(undefined)).toEqual({ providers: {} });
  });

  it("refuses to write anything but the launcher placeholder as a key", () => {
    const leaky = { ...gateway, placeholder: "real-secret-value-1234567890" };

    expect(() => renderModelsJson(leaky)).toThrow(/gateway\.placeholder must start with pi-sandbox-/);
    expect(() => renderAuthJson(leaky)).toThrow(/gateway\.placeholder must start with pi-sandbox-/);
  });
});

describe("renderAuthJson", () => {
  it("stores the placeholder as an api key per provider", () => {
    expect(renderAuthJson(gateway)).toEqual({
      gateway: { type: "api_key", key: "pi-sandbox-placeholder" },
      relay: { type: "api_key", key: "pi-sandbox-placeholder" },
    });
  });

  it("is empty without a gateway", () => {
    expect(renderAuthJson(undefined)).toEqual({});
  });
});
