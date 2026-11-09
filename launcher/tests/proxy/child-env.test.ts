import { describe, expect, it } from "vitest";
import { minimalEnv, parentProxyEnv } from "../../proxy/child-env.ts";

describe("child environments", () => {
  it("keeps only the variables a child needs and never a secret", () => {
    expect(
      minimalEnv({
        PATH: "/usr/bin",
        HOME: "/home/dev",
        TMPDIR: "/tmp",
        NODE_OPTIONS: "--import=/x.mjs",
        GATEWAY_KEY: "secret",
        HTTPS_PROXY: "http://u:p@corp:3128",
        GITHUB_TOKEN: "secret",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", TMPDIR: "/tmp", NODE_OPTIONS: "--import=/x.mjs" });
  });

  it("keeps the config dirs gh and glab read their tokens from", () => {
    expect(
      minimalEnv({
        GH_CONFIG_DIR: "/c/gh",
        GLAB_CONFIG_DIR: "/c/glab",
        XDG_CONFIG_HOME: "/c",
        GH_TOKEN: "secret",
      }),
    ).toEqual({ GH_CONFIG_DIR: "/c/gh", GLAB_CONFIG_DIR: "/c/glab", XDG_CONFIG_HOME: "/c" });
  });

  it("keeps the parent proxy address without its userinfo", () => {
    expect(
      parentProxyEnv({ HTTPS_PROXY: "http://u:p@corp.test:3128", NO_PROXY: "internal.test", PATH: "/x" }),
    ).toEqual({ HTTPS_PROXY: "http://corp.test:3128", NO_PROXY: "internal.test" });
  });
});
