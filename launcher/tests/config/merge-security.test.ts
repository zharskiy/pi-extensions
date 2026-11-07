import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { mergeLayers } from "../../config/merge.ts";
import type { LayerConfig, LayerName } from "../../config/types.ts";
import { errorMessage } from "../../shared/index.ts";

type Layers = Partial<Record<LayerName, LayerConfig>>;

const merge = async (layers: Layers, profile?: LayerConfig) =>
  mergeLayers({ defaults: await defaultConfig(), layers, profile });

const refusal = async (layers: Layers, profile?: LayerConfig) => {
  try {
    await merge(layers, profile);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const gatewayRule = {
  id: "gateway",
  host: "llm.corp.test",
  placeholder: "pi-sandbox-gateway",
  secret: { env: "GATEWAY_KEY" },
};

const gitRule = {
  id: "git",
  host: "git.corp.test",
  header: "authorization",
  template: "Basic {secret}",
  secret: { command: ["corp-git-token"] },
};

describe("mergeLayers with the org layer", () => {
  it("orders the layers policy, org, user, project and records org as a source", async () => {
    const { config, sources } = await merge({
      policy: { egress: { allow: ["a.test", "b.test", "c.test"] } },
      org: { egress: { allow: ["a.test", "b.test"] }, resources: { cpus: 2 } },
      user: { egress: { allow: ["a.test"] } },
    });

    expect(config.egress.allow).toEqual(["a.test"]);
    expect(config.resources.cpus).toBe(2);
    expect(sources["resources.cpus"]).toBe("org");
  });

  it("lets the policy lock the org layer and the org layer lock the user layer", async () => {
    expect(
      await refusal({ policy: { egress: { allow: ["a.test"] } }, org: { egress: { allow: ["x.test"] } } }),
    ).toBe("org: egress.allow cannot add x.test, locked by policy");
    expect(
      await refusal({ org: { egress: { allow: ["a.test"] } }, user: { egress: { allow: ["x.test"] } } }),
    ).toBe("user: egress.allow cannot add x.test, locked by org");
  });

  it("lets a profile chosen by the org layer lock the user layer", async () => {
    expect(
      await refusal({ org: { profile: "team" }, user: { fallback: "host" } }, { fallback: "refuse" }),
    ).toBe("user: fallback cannot become host, locked by profile team");
  });
});

describe("mergeLayers with credential rules", () => {
  it("defaults to no rules and derivation on", async () => {
    const { config } = await merge({});

    expect(config.credentials).toEqual({ kind: "host-pi-auth", rules: [], derive: { enabled: true } });
  });

  it("lets a lower layer drop rules but not add or change them", async () => {
    const policy = { credentials: { rules: [gatewayRule, gitRule] } };

    expect(
      (await merge({ policy, user: { credentials: { rules: [gitRule] } } })).config.credentials.rules,
    ).toEqual([gitRule]);
    expect(
      await refusal({ policy, user: { credentials: { rules: [{ ...gitRule, host: "evil.test" }] } } }),
    ).toBe("user: credentials.rules cannot add or change rules, only drop them, locked by policy");
    expect(
      await refusal({ org: policy, user: { credentials: { rules: [{ ...gitRule, id: "extra" }] } } }),
    ).toBe("user: credentials.rules cannot add or change rules, only drop them, locked by org");
  });

  it("lets the user add rules when no layer above sets any", async () => {
    const { config, sources } = await merge({ user: { credentials: { rules: [gitRule] } } });

    expect(config.credentials.rules).toEqual([gitRule]);
    expect(sources["credentials.rules"]).toBe("user");
  });

  it("keeps a legacy source above and rules below apart", async () => {
    const { config } = await merge({
      policy: { credentials: { kind: "sso", command: ["corp-sso"] } },
      user: { credentials: { rules: [gitRule], derive: { enabled: false } } },
    });

    expect(config.credentials).toEqual({
      kind: "sso",
      command: ["corp-sso"],
      rules: [gitRule],
      derive: { enabled: false },
    });
    expect(
      await refusal({
        policy: { credentials: { kind: "sso", command: ["corp-sso"] } },
        user: { credentials: { kind: "static", envVar: "KEY" } },
      }),
    ).toBe("user: credentials cannot change, locked by policy");
  });

  it("lets derivation turn off below but not on, and its hosts only narrow", async () => {
    expect(
      await refusal({
        policy: { credentials: { derive: { enabled: false } } },
        user: { credentials: { derive: { enabled: true } } },
      }),
    ).toBe("user: credentials.derive.enabled cannot enable, locked by policy");
    expect(
      (
        await merge({
          policy: { credentials: { derive: { enabled: true } } },
          user: { credentials: { derive: { enabled: false } } },
        })
      ).config.credentials.derive.enabled,
    ).toBe(false);
    expect(
      await refusal({
        policy: { credentials: { derive: { hosts: ["*.corp.test"] } } },
        user: { credentials: { derive: { hosts: ["*.other.test"] } } },
      }),
    ).toBe("user: credentials.derive.hosts cannot add entries, locked by policy");
  });
});

describe("mergeLayers with the egress, tls, image and org keys", () => {
  it("has defaults for every egress and tls key", async () => {
    const { config } = await merge({});

    expect(config.egress).toMatchObject({
      deny: [],
      privateHosts: [],
      parentProxy: "env",
      grants: { enabled: true, maxHours: 168, permanent: true },
    });
    expect(config.tls).toEqual({ extraCa: [] });
    expect(config.image.packages).toBeUndefined();
    expect(config.org).toBeUndefined();
  });

  it("unions egress.deny across the layers", async () => {
    const { config } = await merge({
      policy: { egress: { deny: ["a.test"] } },
      org: { egress: { deny: ["b.test"] } },
      user: { egress: { deny: ["c.test", "a.test"] } },
    });

    expect([...config.egress.deny].sort()).toEqual(["a.test", "b.test", "c.test"]);
  });

  it("lets grants only turn off or shrink below a locking layer", async () => {
    const policy = { egress: { grants: { enabled: false, maxHours: 24, permanent: false } } };

    expect(await refusal({ policy, user: { egress: { grants: { enabled: true } } } })).toBe(
      "user: egress.grants.enabled cannot enable, locked by policy",
    );
    expect(await refusal({ policy, user: { egress: { grants: { maxHours: 48 } } } })).toBe(
      "user: egress.grants.maxHours cannot grow, locked by policy",
    );
    expect(await refusal({ policy, user: { egress: { grants: { permanent: true } } } })).toBe(
      "user: egress.grants.permanent cannot enable, locked by policy",
    );
    expect(
      (await merge({ policy, user: { egress: { grants: { maxHours: 8 } } } })).config.egress.grants,
    ).toEqual({
      enabled: false,
      maxHours: 8,
      permanent: false,
    });
  });

  it("lets the user widen grant limits when no layer above set them", async () => {
    const { config } = await merge({ user: { egress: { grants: { maxHours: 720 } } } });

    expect(config.egress.grants.maxHours).toBe(720);
  });

  it("lets private hosts and extra CAs only narrow below a locking layer", async () => {
    expect(
      await refusal({
        policy: { egress: { privateHosts: ["git.corp.internal"] } },
        user: { egress: { privateHosts: ["db.corp.internal"] } },
      }),
    ).toBe("user: egress.privateHosts cannot add entries, locked by policy");
    expect(
      await refusal({
        org: { tls: { extraCa: [{ file: "/etc/corp/ca.pem" }] } },
        user: { tls: { extraCa: [{ hostStore: true }] } },
      }),
    ).toBe("user: tls.extraCa cannot add entries, locked by org");
    expect(
      (
        await merge({
          policy: { tls: { extraCa: [{ file: "/a.pem" }, { hostStore: true }] } },
          user: { tls: { extraCa: [{ hostStore: true }] } },
        })
      ).config.tls.extraCa,
    ).toEqual([{ hostStore: true }]);
  });

  it("keeps the parent proxy fixed once a layer above sets it", async () => {
    expect(
      await refusal({
        policy: { egress: { parentProxy: "none" } },
        user: { egress: { parentProxy: "env" } },
      }),
    ).toBe("user: egress.parentProxy cannot change, locked by policy");

    const { config } = await merge({ user: { egress: { parentProxy: { url: "http://proxy.test:3128" } } } });

    expect(config.egress.parentProxy).toEqual({ url: "http://proxy.test:3128" });
  });

  it("keeps org fixed when the policy sets it and takes the lowest image convenience keys", async () => {
    expect(
      await refusal({
        policy: { org: { source: "/etc/org.json" } },
        user: { org: { source: "/tmp/mine.json" } },
      }),
    ).toBe("user: org cannot change, locked by policy");

    const { config } = await merge({
      org: { image: { packages: ["git"], npmGlobal: ["tool@1.0.0"] } },
      user: { image: { packages: ["chromium"] }, org: { source: "https://config.corp.test/pi.json" } },
    });

    expect(config.image).toMatchObject({ packages: ["chromium"], npmGlobal: ["tool@1.0.0"] });
    expect(config.org).toEqual({ source: "https://config.corp.test/pi.json" });
  });
});

describe("mergeLayers egress cap", () => {
  it("is open when neither the policy nor the org layer sets egress.allow", async () => {
    expect((await merge({ user: { egress: { allow: ["a.test"] } } })).egressCap).toEqual({});
  });

  it("clips derived hosts and grants to an allowlist set by the policy", async () => {
    expect((await merge({ policy: { egress: { allow: ["a.test"] } } })).egressCap).toEqual({
      derivedHosts: ["a.test"],
      grants: ["a.test"],
    });
  });

  it("lifts the cap only where the same layer opts in explicitly", async () => {
    const { egressCap } = await merge({
      policy: { egress: { allow: ["a.test", "b.test"] }, credentials: { derive: { enabled: true } } },
      org: { egress: { allow: ["a.test"], grants: { enabled: true } } },
    });

    expect(egressCap).toEqual({ derivedHosts: ["a.test"], grants: ["a.test", "b.test"] });
  });

  it("intersects the policy and org allowlists", async () => {
    const { egressCap } = await merge({
      policy: { egress: { allow: ["a.test", "b.test"] } },
      org: { egress: { allow: ["b.test"] } },
    });

    expect(egressCap).toEqual({ derivedHosts: ["b.test"], grants: ["b.test"] });
  });

  it("ignores an opt-in without an allowlist and an opt-in made by the user", async () => {
    expect((await merge({ policy: { credentials: { derive: { enabled: true } } } })).egressCap).toEqual({});
    expect(
      (
        await merge({
          policy: { egress: { allow: ["a.test"] } },
          user: { credentials: { derive: { enabled: true } } },
        })
      ).egressCap,
    ).toEqual({ derivedHosts: ["a.test"], grants: ["a.test"] });
  });
});
