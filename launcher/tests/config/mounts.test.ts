import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { loadEffectiveConfig } from "../../config/index.ts";
import { validateLayer } from "../../config/validate.ts";
import { errorMessage } from "../../shared/index.ts";
import { createLayers } from "./fixtures.ts";

const problemOf = (sharedCaches: unknown) => {
  try {
    validateLayer({ mounts: { sharedCaches } }, "user");

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const loadWith = async (layers: { policy?: unknown; user?: unknown }) => {
  const files = await createLayers();

  if (layers.policy !== undefined) {
    await files.policy(layers.policy);
  }

  if (layers.user !== undefined) {
    await files.user(layers.user);
  }

  return loadEffectiveConfig({ env: files.env });
};

describe("mounts.sharedCaches", () => {
  it("defaults to no shared caches and node_modules overlays on", async () => {
    const { config, sources } = await loadWith({});

    expect(defaultConfig().mounts).toEqual({ sharedCaches: [], autoOverlays: true });
    expect(config.mounts).toMatchObject({ sharedCaches: [], autoOverlays: true });
    expect(sources["mounts.sharedCaches"]).toBe("default");
  });

  it("accepts directories below the home dir, with or without a trailing slash", () => {
    expect(problemOf(["~/.cache/pip", "~/.npm/", "~/.gradle", "~/.local/share/pnpm"])).toBeUndefined();
  });

  it.each([
    ["~", "user: mounts.sharedCaches[0] ~ must start with ~/"],
    ["/abs", "user: mounts.sharedCaches[0] /abs must start with ~/"],
    ["~/", "user: mounts.sharedCaches[0] ~/ must name a directory below ~ without empty, . or .. segments"],
    [
      "~/a/../b",
      "user: mounts.sharedCaches[0] ~/a/../b must name a directory below ~ without empty, . or .. segments",
    ],
    [
      "~/a//b",
      "user: mounts.sharedCaches[0] ~/a//b must name a directory below ~ without empty, . or .. segments",
    ],
    [
      "~/./a",
      "user: mounts.sharedCaches[0] ~/./a must name a directory below ~ without empty, . or .. segments",
    ],
    ["~/.pi", "user: mounts.sharedCaches[0] ~/.pi must not be or lie under ~/.pi"],
    ["~/.pi/agent", "user: mounts.sharedCaches[0] ~/.pi/agent must not be or lie under ~/.pi"],
    ["~/.config/gh", "user: mounts.sharedCaches[0] ~/.config/gh must not be or lie under ~/.config"],
    ["~/.ssh", "user: mounts.sharedCaches[0] ~/.ssh must not be or lie under ~/.ssh"],
    ["~/.gnupg/", "user: mounts.sharedCaches[0] ~/.gnupg/ must not be or lie under ~/.gnupg"],
    ["~/.aws/sso", "user: mounts.sharedCaches[0] ~/.aws/sso must not be or lie under ~/.aws"],
    ["~/.docker", "user: mounts.sharedCaches[0] ~/.docker must not be or lie under ~/.docker"],
    ["~/.colima/", "user: mounts.sharedCaches[0] ~/.colima/ must not be or lie under ~/.colima"],
    ["~/.kube", "user: mounts.sharedCaches[0] ~/.kube must not be or lie under ~/.kube"],
    ["~/.local/bin", "user: mounts.sharedCaches[0] ~/.local/bin must not be or lie under ~/.local/bin"],
    [
      "~/.local/bin/tool",
      "user: mounts.sharedCaches[0] ~/.local/bin/tool must not be or lie under ~/.local/bin",
    ],
  ])("refuses %s", (path, message) => {
    expect(problemOf([path])).toBe(message);
  });

  it("refuses the same directory twice, also when one entry has a trailing slash", () => {
    expect(problemOf(["~/.npm", "~/.npm/"])).toBe("user: mounts.sharedCaches lists ~/.npm twice");
  });

  it("refuses a directory nested in another entry", () => {
    expect(problemOf(["~/.cache/pip", "~/.cache"])).toBe(
      "user: mounts.sharedCaches lists ~/.cache/pip inside another entry",
    );
  });

  it("lets the user layer add shared caches when no layer above sets them", async () => {
    const { config, sources } = await loadWith({
      user: { mounts: { sharedCaches: ["~/.npm", "~/.cargo"] } },
    });

    expect(config.mounts.sharedCaches).toEqual(["~/.npm", "~/.cargo"]);
    expect(sources["mounts.sharedCaches"]).toBe("user");
  });

  it("keeps the shared caches the policy set", async () => {
    const policy = { mounts: { sharedCaches: ["~/.npm", "~/.cargo"] } };

    const { config, ignored } = await loadWith({ policy, user: { mounts: { sharedCaches: ["~/.npm"] } } });

    expect(config.mounts.sharedCaches).toEqual(["~/.npm", "~/.cargo"]);
    expect(ignored).toEqual([
      { layer: "user", key: "mounts.sharedCaches", reason: "final in the policy config" },
    ]);
  });
});

describe("mounts.autoOverlays", () => {
  it("is taken from the user when the policy leaves it open", async () => {
    const { config, sources } = await loadWith({ user: { mounts: { autoOverlays: false } } });

    expect(config.mounts.autoOverlays).toBe(false);
    expect(sources["mounts.autoOverlays"]).toBe("user");
  });

  it("stays as the policy set it", async () => {
    const { config, ignored } = await loadWith({
      policy: { mounts: { autoOverlays: false } },
      user: { mounts: { autoOverlays: true } },
    });

    expect(config.mounts.autoOverlays).toBe(false);
    expect(ignored).toEqual([
      { layer: "user", key: "mounts.autoOverlays", reason: "final in the policy config" },
    ]);
  });

  it("must be true or false", () => {
    expect(() => validateLayer({ mounts: { autoOverlays: "off" } }, "user")).toThrow(
      "user: mounts.autoOverlays must be true or false",
    );
  });
});
