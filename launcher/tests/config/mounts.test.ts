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

const loadWith = async (layers: { policy?: unknown; user?: unknown; project?: unknown }) => {
  const files = await createLayers();

  if (layers.policy !== undefined) {
    await files.policy(layers.policy);
  }

  if (layers.user !== undefined) {
    await files.user(layers.user);
  }

  if (layers.project !== undefined) {
    await files.project(layers.project);
  }

  return loadEffectiveConfig({ repoRoot: files.repoRoot, env: files.env });
};

describe("mounts.sharedCaches", () => {
  it("defaults to no shared caches and node_modules overlays on", async () => {
    const { config, sources } = await loadWith({});

    expect((await defaultConfig()).mounts).toMatchObject({ sharedCaches: [], autoNodeModules: true });
    expect(config.mounts).toMatchObject({ sharedCaches: [], autoNodeModules: true });
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

  it("refuses a project config that sets shared caches", async () => {
    await expect(loadWith({ project: { mounts: { sharedCaches: ["~/.npm"] } } })).rejects.toThrow(
      "project: mounts.sharedCaches may not be set by a project config",
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

    await expect(loadWith({ policy, user: { mounts: { sharedCaches: ["~/.npm"] } } })).rejects.toThrow(
      "user: mounts.sharedCaches is set by the policy config and is final there",
    );
  });
});

describe("mounts.autoNodeModules", () => {
  it("is taken from the lowest layer that sets it, the project included", async () => {
    const { config, sources } = await loadWith({
      user: { mounts: { autoNodeModules: true } },
      project: { mounts: { autoNodeModules: false } },
    });

    expect(config.mounts.autoNodeModules).toBe(false);
    expect(sources["mounts.autoNodeModules"]).toBe("project");
  });

  it("stays as the policy set it", async () => {
    await expect(
      loadWith({
        policy: { mounts: { autoNodeModules: false } },
        project: { mounts: { autoNodeModules: true } },
      }),
    ).rejects.toThrow("project: mounts.autoNodeModules is set by the policy config and is final there");
  });

  it("must be true or false", () => {
    expect(() => validateLayer({ mounts: { autoNodeModules: "off" } }, "project")).toThrow(
      "project: mounts.autoNodeModules must be true or false",
    );
  });
});
