import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { loadEffectiveConfig } from "../../config/index.ts";
import { mergeLayers } from "../../config/merge.ts";
import type { LayerConfig, LayerName } from "../../config/types.ts";
import { validateLayer } from "../../config/validate.ts";
import { forwardedEnv } from "../../container/index.ts";
import { errorMessage } from "../../shared/index.ts";
import { createLayers } from "./fixtures.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const merge = async (layers: Layers) => mergeLayers({ defaults: await defaultConfig(), layers });

const refusal = async (layers: Layers) => {
  try {
    await merge(layers);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const problemOf = (value: unknown, layer: string) => {
  try {
    validateLayer(value, layer);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

describe("sessions.host", () => {
  it("is on by default", async () => {
    const { config, sources } = await merge({});

    expect(config.sessions.host).toBe(true);
    expect(sources["sessions.host"]).toBe("default");
  });

  it("lets the user layer turn it off", async () => {
    const { config, sources } = await merge({ user: { sessions: { host: false } } });

    expect(config.sessions.host).toBe(false);
    expect(sources["sessions.host"]).toBe("user");
  });

  it("stays off once the policy or org layer turns it off", async () => {
    expect(await refusal({ policy: { sessions: { host: false } }, user: { sessions: { host: true } } })).toBe(
      "user: sessions.host cannot enable, locked by policy",
    );
    expect(await refusal({ org: { sessions: { host: false } }, user: { sessions: { host: true } } })).toBe(
      "user: sessions.host cannot enable, locked by org",
    );
    expect((await merge({ policy: { sessions: { host: false } } })).config.sessions.host).toBe(false);
  });

  it("must be true or false", () => {
    expect(problemOf({ sessions: { host: "yes" } }, "user")).toBe(
      "user: sessions.host must be true or false",
    );
    expect(problemOf({ sessions: { dir: "/tmp" } }, "user")).toBe("user: sessions.dir is not a known key");
  });

  it("may not be set by a project config, not even to false", async () => {
    const files = await createLayers();

    await files.project({ sessions: { host: false } });

    await expect(loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env })).rejects.toThrow(
      `project: sessions.host may not be set by a project config (${files.projectFile})`,
    );
  });
});

describe("env.allow and the launcher's pi directory variables", () => {
  it("refuses PI_CODING_AGENT_SESSION_DIR and PI_CODING_AGENT_DIR", () => {
    expect(problemOf({ env: { allow: ["PI_CODING_AGENT_SESSION_DIR"] } }, "user")).toBe(
      "user: env.allow[0] PI_CODING_AGENT_SESSION_DIR is set by the launcher and is not forwarded",
    );
    expect(problemOf({ env: { allow: ["EDITOR", "PI_CODING_AGENT_DIR"] } }, "policy")).toBe(
      "policy: env.allow[1] PI_CODING_AGENT_DIR is set by the launcher and is not forwarded",
    );
  });

  it("never forwards them, even when a name list carries them", () => {
    const env = { PI_CODING_AGENT_SESSION_DIR: "/elsewhere", PI_CODING_AGENT_DIR: "/agent", EDITOR: "vi" };

    expect(forwardedEnv(["PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR", "EDITOR"], env)).toEqual({
      EDITOR: "vi",
    });
  });
});
