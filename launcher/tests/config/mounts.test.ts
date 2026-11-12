import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { loadEffectiveConfig } from "../../config/index.ts";
import { validateConfig } from "../../config/validate.ts";
import { errorMessage } from "../../shared/index.ts";
import { createConfigFile } from "./fixtures.ts";

const problemOf = (sharedCaches: unknown) => {
  try {
    validateConfig({ mounts: { sharedCaches } });

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const loadWith = async (config?: unknown) => {
  const file = await createConfigFile();

  if (config !== undefined) {
    await file.write(config);
  }

  return loadEffectiveConfig({ env: file.env });
};

describe("mounts.sharedCaches", () => {
  it("defaults to no shared caches and node_modules overlays on", async () => {
    const { config, sources } = await loadWith();

    expect(defaultConfig().mounts).toEqual({ sharedCaches: [], autoOverlays: true });
    expect(config.mounts).toMatchObject({ sharedCaches: [], autoOverlays: true });
    expect(sources["mounts.sharedCaches"]).toBe("default");
  });

  it("accepts directories below the home dir, with or without a trailing slash", () => {
    expect(problemOf(["~/.cache/pip", "~/.npm/", "~/.gradle", "~/.local/share/pnpm"])).toBeUndefined();
  });

  it.each([
    ["~", "config: mounts.sharedCaches[0] ~ must start with ~/"],
    ["/abs", "config: mounts.sharedCaches[0] /abs must start with ~/"],
    ["~/", "config: mounts.sharedCaches[0] ~/ must name a directory below ~ without empty, . or .. segments"],
    [
      "~/a/../b",
      "config: mounts.sharedCaches[0] ~/a/../b must name a directory below ~ without empty, . or .. segments",
    ],
    [
      "~/a//b",
      "config: mounts.sharedCaches[0] ~/a//b must name a directory below ~ without empty, . or .. segments",
    ],
    [
      "~/./a",
      "config: mounts.sharedCaches[0] ~/./a must name a directory below ~ without empty, . or .. segments",
    ],
    ["~/.pi", "config: mounts.sharedCaches[0] ~/.pi must not be or lie under ~/.pi"],
    ["~/.pi/agent", "config: mounts.sharedCaches[0] ~/.pi/agent must not be or lie under ~/.pi"],
    ["~/.config/gh", "config: mounts.sharedCaches[0] ~/.config/gh must not be or lie under ~/.config"],
    ["~/.ssh", "config: mounts.sharedCaches[0] ~/.ssh must not be or lie under ~/.ssh"],
    ["~/.gnupg/", "config: mounts.sharedCaches[0] ~/.gnupg/ must not be or lie under ~/.gnupg"],
    ["~/.aws/sso", "config: mounts.sharedCaches[0] ~/.aws/sso must not be or lie under ~/.aws"],
    ["~/.docker", "config: mounts.sharedCaches[0] ~/.docker must not be or lie under ~/.docker"],
    ["~/.colima/", "config: mounts.sharedCaches[0] ~/.colima/ must not be or lie under ~/.colima"],
    ["~/.kube", "config: mounts.sharedCaches[0] ~/.kube must not be or lie under ~/.kube"],
    ["~/.local/bin", "config: mounts.sharedCaches[0] ~/.local/bin must not be or lie under ~/.local/bin"],
    [
      "~/.local/bin/tool",
      "config: mounts.sharedCaches[0] ~/.local/bin/tool must not be or lie under ~/.local/bin",
    ],
  ])("refuses %s", (path, message) => {
    expect(problemOf([path])).toBe(message);
  });

  it("refuses the same directory twice, also when one entry has a trailing slash", () => {
    expect(problemOf(["~/.npm", "~/.npm/"])).toBe("config: mounts.sharedCaches lists ~/.npm twice");
  });

  it("refuses a directory nested in another entry", () => {
    expect(problemOf(["~/.cache/pip", "~/.cache"])).toBe(
      "config: mounts.sharedCaches lists ~/.cache/pip inside another entry",
    );
  });

  it("takes the shared caches from the config", async () => {
    const { config, sources } = await loadWith({ mounts: { sharedCaches: ["~/.npm", "~/.cargo"] } });

    expect(config.mounts.sharedCaches).toEqual(["~/.npm", "~/.cargo"]);
    expect(sources["mounts.sharedCaches"]).toBe("config");
  });
});

describe("mounts.autoOverlays", () => {
  it("is taken from the config", async () => {
    const { config, sources } = await loadWith({ mounts: { autoOverlays: false } });

    expect(config.mounts.autoOverlays).toBe(false);
    expect(sources["mounts.autoOverlays"]).toBe("config");
  });

  it("must be true or false", () => {
    expect(() => validateConfig({ mounts: { autoOverlays: "off" } })).toThrow(
      "config: mounts.autoOverlays must be true or false",
    );
  });
});
