import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setPath } from "../../config/dotted.ts";
import { setConfigValue } from "../../config/index.ts";
import { validateLayerFile } from "../../config/load.ts";
import { createLayers } from "./fixtures.ts";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const REFUSED: Array<[string, unknown]> = [
  [
    "credentials.rules",
    [{ id: "corp", host: "llm.corp.test", placeholder: "pi-sandbox-corp", secret: { env: "CORP_KEY" } }],
  ],
  ["credentials.derive", { enabled: false }],
  ["credentials.vault", { enabled: false }],
  ["egress.deny", ["paste.example.test"]],
  ["egress.privateHosts", ["git.corp.internal"]],
  ["egress.parentProxy", "none"],
  ["egress.grants", { enabled: false }],
  ["tls", { extraCa: [] }],
  ["image.packages", ["git"]],
  ["image.npmGlobal", ["tool@1.0.0"]],
  ["image.dockerfile", "/etc/pi-sandbox/layer.Dockerfile"],
  ["mounts.sharedCaches", ["~/.npm"]],
  ["org", { source: "/etc/pi-sandbox/org.json" }],
  ["env.allow", ["EDITOR"]],
  ["image.reference", "evil/pi"],
  ["image.digest", `sha256:${"e".repeat(64)}`],
  ["sessions.host", false],
];

describe("keys a project config may not set", () => {
  it.each(REFUSED)("refuses %s when a project file is read", (key, value) => {
    const file = "/repo/.pi/sandbox.json";

    expect(() => validateLayerFile(setPath({}, key, value), "project", file)).toThrow(
      `project: ${key} may not be set by a project config (${file})`,
    );
    expect(validateLayerFile(setPath({}, key, value), "user", "/home/user/config.json")).toEqual(
      setPath({}, key, value),
    );
  });

  it.each(REFUSED)("refuses %s through config set --project and writes nothing", async (key, value) => {
    const files = await createLayers();

    await expect(
      setConfigValue({ layer: "project", key, value, repoRoot: files.repoRoot, env: files.env }),
    ).rejects.toThrow(`project: ${key} may not be set by a project config`);
    expect(await exists(join(files.repoRoot, ".pi"))).toBe(false);
  });
});
