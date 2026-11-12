import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { mergeConfig } from "../../config/merge.ts";
import type { UserConfig } from "../../config/types.ts";
import { validateConfig } from "../../config/validate.ts";
import { forwardedEnv } from "../../container/index.ts";
import { errorMessage } from "../../shared/index.ts";

const merge = (config: UserConfig) => mergeConfig(defaultConfig(), config);

const problemOf = (value: unknown) => {
  try {
    validateConfig(value);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

describe("sessions.host", () => {
  it("is on by default", () => {
    const { config, sources } = merge({});

    expect(config.sessions.host).toBe(true);
    expect(sources["sessions.host"]).toBe("default");
  });

  it("lets the config turn it off", () => {
    const { config, sources } = merge({ sessions: { host: false } });

    expect(config.sessions.host).toBe(false);
    expect(sources["sessions.host"]).toBe("config");
  });

  it("must be true or false", () => {
    expect(problemOf({ sessions: { host: "yes" } })).toBe("config: sessions.host must be true or false");
    expect(problemOf({ sessions: { dir: "/tmp" } })).toBe("config: sessions.dir is not a known key");
  });
});

describe("env.allow and the launcher's pi directory variables", () => {
  it("refuses PI_CODING_AGENT_SESSION_DIR and PI_CODING_AGENT_DIR", () => {
    expect(problemOf({ env: { allow: ["PI_CODING_AGENT_SESSION_DIR"] } })).toBe(
      "config: env.allow[0] PI_CODING_AGENT_SESSION_DIR is set by the launcher and is not forwarded",
    );
    expect(problemOf({ env: { allow: ["EDITOR", "PI_CODING_AGENT_DIR"] } })).toBe(
      "config: env.allow[1] PI_CODING_AGENT_DIR is set by the launcher and is not forwarded",
    );
  });

  it("never forwards them, even when a name list carries them", () => {
    const env = { PI_CODING_AGENT_SESSION_DIR: "/elsewhere", PI_CODING_AGENT_DIR: "/agent", EDITOR: "vi" };

    expect(forwardedEnv(["PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR", "EDITOR"], env)).toEqual({
      EDITOR: "vi",
    });
  });
});
