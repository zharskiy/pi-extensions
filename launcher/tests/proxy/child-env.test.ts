import { describe, expect, it } from "vitest";
import { helperProxyEnv, minimalEnv, parentProxyEnv } from "../../proxy/child-env.ts";
import { basicAuthorization, parentRouteFor } from "../../proxy/parent.ts";

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

  it("keeps the config dirs glab reads its token from", () => {
    expect(
      minimalEnv({
        GLAB_CONFIG_DIR: "/c/glab",
        XDG_CONFIG_HOME: "/c",
        GITLAB_TOKEN: "secret",
      }),
    ).toEqual({ GLAB_CONFIG_DIR: "/c/glab", XDG_CONFIG_HOME: "/c" });
  });

  it("keeps the parent proxy address without its userinfo", () => {
    expect(
      parentProxyEnv({ HTTPS_PROXY: "http://u:p@corp.test:3128", NO_PROXY: "internal.test", PATH: "/x" }),
    ).toEqual({ HTTPS_PROXY: "http://corp.test:3128", NO_PROXY: "internal.test" });
  });

  it("gives the host helpers the parent proxy with its credentials, and nothing else changes", () => {
    const parentEnv = parentProxyEnv({
      HTTPS_PROXY: "http://u%40corp:p%3Ass@corp.test:3128",
      https_proxy: "http://u%40corp:p%3Ass@corp.test:3128",
      NO_PROXY: "internal.test",
    });

    expect(helperProxyEnv(parentEnv, "u@corp:p:ss")).toEqual({
      HTTPS_PROXY: "http://u%40corp:p%3Ass@corp.test:3128/",
      https_proxy: "http://u%40corp:p%3Ass@corp.test:3128/",
      NO_PROXY: "internal.test",
    });
    expect(helperProxyEnv(parentEnv, undefined)).toEqual(parentEnv);
  });

  it("hands the daemon's parent route the credentials the launcher sent on stdin", () => {
    const parentEnv = parentProxyEnv({ HTTPS_PROXY: "http://u%40corp:p%3Ass@corp.test:3128" });

    expect(parentRouteFor(parentEnv)?.authorization).toBeUndefined();
    expect(parentRouteFor(helperProxyEnv(parentEnv, "u@corp:p:ss"))).toEqual({
      host: "corp.test",
      port: 3128,
      noProxy: [],
      authorization: basicAuthorization("u@corp:p:ss"),
    });
  });
});
