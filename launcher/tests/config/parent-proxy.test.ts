import { describe, expect, it } from "vitest";
import { parentProxyOf } from "../../config/index.ts";

describe("parentProxyOf", () => {
  it("is unset for parentProxy none, and for an unset or empty HTTPS_PROXY", () => {
    expect(parentProxyOf("none", { HTTPS_PROXY: "http://corp.test:3128" })).toBeUndefined();
    expect(parentProxyOf("env", {})).toBeUndefined();
    expect(parentProxyOf("env", { HTTPS_PROXY: "", https_proxy: "" })).toBeUndefined();
  });

  it("reads HTTPS_PROXY before https_proxy, an empty one counting as unset, with NO_PROXY", () => {
    expect(
      parentProxyOf("env", {
        HTTPS_PROXY: "",
        https_proxy: "http://corp.test:3128",
        NO_PROXY: "",
        no_proxy: "internal.test, .corp.test",
      }),
    ).toEqual({
      host: "corp.test",
      port: 3128,
      hasCredentials: false,
      noProxy: ["internal.test", ".corp.test"],
    });
    expect(
      parentProxyOf("env", {
        HTTPS_PROXY: "http://a.test",
        https_proxy: "http://b.test",
        NO_PROXY: "x.test",
      }),
    ).toEqual({ host: "a.test", port: 80, hasCredentials: false, noProxy: ["x.test"] });
  });

  it("decodes the credentials and strips the brackets of an IPv6 host", () => {
    expect(parentProxyOf("env", { HTTPS_PROXY: "http://me%40corp:p%3Ass@[::1]:8080" })).toEqual({
      host: "::1",
      port: 8080,
      hasCredentials: true,
      credentials: "me@corp:p:ss",
      noProxy: [],
    });
  });

  it("names what it cannot use", () => {
    expect(parentProxyOf("env", { HTTPS_PROXY: "corp.test:3128" })).toEqual({
      unsupported: "HTTPS_PROXY uses corp.test, only http parent proxies are supported",
    });
    expect(parentProxyOf("env", { HTTPS_PROXY: "not a url" })).toEqual({
      unsupported: "HTTPS_PROXY is not a URL",
    });
    expect(parentProxyOf("env", { HTTPS_PROXY: "https://corp.test" })).toEqual({
      unsupported: "HTTPS_PROXY uses https, only http parent proxies are supported",
    });
    expect(parentProxyOf("env", { HTTPS_PROXY: "http://%E0%A4%A@corp.test" })).toEqual({
      unsupported: "HTTPS_PROXY holds credentials that are not URL-encoded",
    });
  });
});
