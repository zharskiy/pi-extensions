import { describe, expect, it } from "vitest";
import { packageIdentity } from "../../provision/index.ts";

describe("packageIdentity", () => {
  it("keys an npm source by its package name, scoped or not, with or without a version", () => {
    expect(packageIdentity("npm:@zharskiy/pinata@0.5.0")).toBe("npm:@zharskiy/pinata");
    expect(packageIdentity("npm:@zharskiy/pinata")).toBe("npm:@zharskiy/pinata");
    expect(packageIdentity("npm:@zharskiy/pinata@^0.5")).toBe("npm:@zharskiy/pinata");
    expect(packageIdentity("npm: @zharskiy/pinata@latest")).toBe("npm:@zharskiy/pinata");
    expect(packageIdentity("npm:plain-name@1.2.3")).toBe("npm:plain-name");
  });

  it("keys a git source by host and path, with the ref ignored", () => {
    const identity = "git:github.com/zharskiy/pi-extensions";

    expect(packageIdentity("git:github.com/zharskiy/pi-extensions@v0.5.0")).toBe(identity);
    expect(packageIdentity("https://github.com/zharskiy/pi-extensions.git")).toBe(identity);
  });

  it("refuses a malformed npm name and a local path", () => {
    expect(packageIdentity("npm:@zharskiy/")).toBeUndefined();
    expect(packageIdentity("npm:@/pinata")).toBeUndefined();
    expect(packageIdentity("./pinata")).toBeUndefined();
  });
});
