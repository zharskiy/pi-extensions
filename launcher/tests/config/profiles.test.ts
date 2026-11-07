import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../../config/profiles.ts";
import { validateLayer } from "../../config/validate.ts";
import { launcherRoot } from "../../shared/index.ts";

const readJson = async (...parts: string[]) =>
  JSON.parse(await readFile(join(launcherRoot(), ...parts), "utf8")) as unknown;

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

describe("org baseline examples", () => {
  it.each(["team", "enterprise"])("validates org-baseline.%s.json as an org layer", async (name) => {
    const layer = validateLayer(await readJson("examples", `org-baseline.${name}.json`), "org");

    expect(layer.credentials?.rules?.length).toBeGreaterThan(0);
    expect(layer.tls?.extraCa?.length).toBeGreaterThan(0);
    expect(layer.image?.packages?.length).toBeGreaterThan(0);
    expect(layer.egress?.grants?.maxHours).toBeDefined();
  });

  it.each(["team", "enterprise"])("keeps the %s profile usable as an org layer", async (name) => {
    expect(validateLayer(await readJson("profiles", `${name}.json`), "org")).toEqual(await loadProfile(name));
  });
});
