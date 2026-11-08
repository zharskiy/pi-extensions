import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { vaultEnabled } from "../../config/index.ts";
import { mergeLayers } from "../../config/merge.ts";
import type { LayerConfig, LayerName } from "../../config/types.ts";
import { validateLayer } from "../../config/validate.ts";
import { errorMessage } from "../../shared/index.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const merge = async (layers: Layers) => mergeLayers({ defaults: await defaultConfig(), layers });

const problemOf = async (run: () => unknown) => {
  try {
    await run();

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

describe("credentials.vault", () => {
  it("is on by default", async () => {
    const { config } = await merge({});

    expect(config.credentials.vault).toEqual({ enabled: true });

    expect(vaultEnabled(config)).toBe(true);
  });

  it("is effective only while derivation is enabled", async () => {
    const { config } = await merge({ user: { credentials: { derive: { enabled: false } } } });

    expect(config.credentials.vault.enabled).toBe(true);

    expect(vaultEnabled(config)).toBe(false);
  });

  it("can be turned off by the user", async () => {
    const { config } = await merge({ user: { credentials: { vault: { enabled: false } } } });

    expect(vaultEnabled(config)).toBe(false);
  });

  it("cannot be changed below a layer that set it", async () => {
    const problem = await problemOf(() =>
      merge({
        policy: { credentials: { vault: { enabled: false } } },
        user: { credentials: { vault: { enabled: true } } },
      }),
    );

    expect(problem).toBe("user: credentials.vault.enabled is set by the policy config and is final there");
  });

  it("is refused in a project config", async () => {
    const problem = await problemOf(() =>
      validateLayer({ credentials: { vault: { enabled: false } } }, "project"),
    );

    expect(problem).toBe("project: credentials.vault.enabled may not be set by a project config");
  });

  it("refuses a value that is not a boolean and an unknown key", async () => {
    expect(
      await problemOf(() => validateLayer({ credentials: { vault: { enabled: "yes" } } }, "user")),
    ).toMatch(/^user: credentials\.vault\.enabled /);

    expect(await problemOf(() => validateLayer({ credentials: { vault: { other: true } } }, "user"))).toMatch(
      /^user: credentials\.vault\.other /,
    );
  });
});
