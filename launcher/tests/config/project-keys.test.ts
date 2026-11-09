import { describe, expect, it } from "vitest";
import { setPath } from "../../config/dotted.ts";
import { validateLayerFile } from "../../config/load.ts";

const REFUSED: Array<[string, unknown]> = [
  [
    "credentials.rules",
    [{ id: "corp", host: "llm.corp.test", placeholder: "pi-sandbox-corp", secret: { env: "CORP_KEY" } }],
  ],
  ["credentials.derive.enabled", false],
  ["egress.allow", ["evil.example.test"]],
  ["egress.presets", ["cargo"]],
  ["egress.deny", ["paste.example.test"]],
  ["egress.privateHosts", ["git.corp.internal"]],
  ["egress.parentProxy", "none"],
  ["egress.grants", false],
  ["tls.extraCa", []],
  ["fallback", "host"],
  ["image.packages", ["git"]],
  ["image.npmGlobal", ["tool@1.0.0"]],
  ["image.dockerfile", "/etc/pi-sandbox/layer.Dockerfile"],
  ["image.reference", "evil/pi"],
  ["image.digest", `sha256:${"e".repeat(64)}`],
  ["mounts.extraReadOnly", ["/opt"]],
  ["mounts.sharedCaches", ["~/.npm"]],
  ["mounts.hostCaches", ["maven"]],
  ["org", "/etc/pi-sandbox/org.json"],
  ["env.allow", ["EDITOR"]],
  ["sessions.host", false],
];

const ALLOWED: Array<[string, unknown]> = [
  ["mounts.cacheVolumes", ["node_modules"]],
  ["mounts.autoNodeModules", false],
  ["resources.cpus", 2],
  ["resources.memoryGiB", 4],
];

describe("keys a project config may set", () => {
  it.each(REFUSED)("refuses %s when a project file is read", (key, value) => {
    const file = "/repo/.pi/sandbox.json";

    expect(() => validateLayerFile(setPath({}, key, value), "project", file)).toThrow(
      `project: ${key} may not be set by a project config (${file})`,
    );
    expect(validateLayerFile(setPath({}, key, value), "user", "/home/user/config.json")).toEqual(
      setPath({}, key, value),
    );
  });

  it.each(ALLOWED)("accepts %s", (key, value) => {
    expect(validateLayerFile(setPath({}, key, value), "project", "/repo/.pi/sandbox.json")).toEqual(
      setPath({}, key, value),
    );
  });
});
