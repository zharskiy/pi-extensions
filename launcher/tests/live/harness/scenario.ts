import { PROVIDER } from "../fixtures/llm-fixture.ts";
import { ALL_FIXTURE_HOSTS } from "./names.ts";
import type { LiveSandbox } from "./sandbox.ts";

export interface FixtureConfigOptions {
  allow?: string[];
  extraCa?: string[];
  egress?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export const MODEL_ARGS = ["--model", `${PROVIDER.provider}/${PROVIDER.model}`];

export const fixtureConfig = (sandbox: LiveSandbox, options: FixtureConfigOptions = {}) => ({
  egress: {
    allow: options.allow ?? [],
    privateHosts: ALL_FIXTURE_HOSTS,
    ...options.egress,
  },
  tls: { extraCa: [sandbox.ca.certPath, ...(options.extraCa ?? [])].map((file) => ({ file })) },
  ...options.extra,
});

export const providerModels = (baseUrl: string, apiKey: string) => ({
  providers: {
    [PROVIDER.provider]: {
      baseUrl,
      api: PROVIDER.api,
      apiKey,
      models: [{ id: PROVIDER.model, name: PROVIDER.model }],
    },
  },
});

export const providerSettings = () => ({ defaultProvider: PROVIDER.provider, defaultModel: PROVIDER.model });

export const randomSecret = (label: string) =>
  `${label}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
