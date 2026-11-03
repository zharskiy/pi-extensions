import { describe, expect, it } from "vitest";
import { loadProfile } from "../../config/profiles.ts";

describe("loadProfile", () => {
  it("ships solo with host credentials and the host fallback", async () => {
    const solo = await loadProfile("solo");

    expect(solo.fallback).toBe("host");
    expect(solo.credentials).toEqual({ kind: "host-pi-auth" });
    expect(solo.egress?.allow).toEqual([
      "registry.npmjs.org",
      "github.com",
      "pypi.org",
      "files.pythonhosted.org",
    ]);
  });

  it("ships team as solo with a refused fallback and static credentials", async () => {
    const solo = await loadProfile("solo");

    expect(await loadProfile("team")).toEqual({
      ...solo,
      fallback: "refuse",
      credentials: { kind: "static" },
    });
  });

  it("ships enterprise with sso, a refused fallback and an empty allowlist", async () => {
    const enterprise = await loadProfile("enterprise");

    expect(enterprise.fallback).toBe("refuse");
    expect(enterprise.credentials).toEqual({ kind: "sso", command: [] });
    expect(enterprise.egress?.allow).toEqual([]);
  });

  it("refuses an unknown profile", async () => {
    await expect(loadProfile("startup")).rejects.toThrow("profile startup: unknown profile");
  });
});
