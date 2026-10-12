import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySettings,
  parseSettings,
  projectSettingsPath,
  readSettingsFile,
  type SettingsSchema,
  userSettingsPath,
} from "../../manager/settings.ts";

type Example = { count: number; ratio: number; names: string[]; loud?: boolean };

const schema: SettingsSchema<Example> = {
  count: { type: "number", min: 1, max: 10 },
  ratio: { type: "number", min: 0, max: 1, minExclusive: true },
  names: { type: "list", of: "names" },
  loud: { type: "boolean" },
};

describe("settings helpers", () => {
  it("validates numbers and lists, keeps valid values and ignores unknown keys", () => {
    const parsed = parseSettings(schema, { count: 11, ratio: 0.5, names: ["a"], other: true }, "f.json");

    expect(parsed.patch).toEqual({ ratio: 0.5, names: ["a"] });
    expect(parsed.errors).toEqual(["f.json: count must be a number between 1 and 10"]);
  });

  it("words exclusive bounds and lists in the error", () => {
    const parsed = parseSettings(schema, { ratio: 0, names: [1], count: Number.NaN }, "f.json");

    expect(parsed.errors).toEqual([
      "f.json: count must be a number between 1 and 10",
      "f.json: ratio must be a number above 0 and at most 1",
      "f.json: names must be a list of names",
    ]);
  });

  it("accepts booleans and rejects anything else for a boolean rule", () => {
    expect(parseSettings(schema, { loud: false }, "f").patch).toEqual({ loud: false });
    expect(parseSettings(schema, { loud: "no" }, "f").errors).toEqual(["f: loud must be true or false"]);
    expect(parseSettings(schema, { loud: 0 }, "f").patch).toEqual({});
  });

  it("rejects anything but a JSON object", () => {
    expect(parseSettings(schema, [], "f").errors).toEqual(["f: expected a JSON object"]);
    expect(parseSettings(schema, null, "f").errors).toEqual(["f: expected a JSON object"]);
  });

  it("reads files, treats a missing file as empty and reports unreadable JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-core-settings-"));
    const user = userSettingsPath(join(root, "agent"), "example.json");
    const project = projectSettingsPath(join(root, "project"), "example.json");

    expect(user).toBe(join(root, "agent", "example.json"));
    expect(project).toBe(join(root, "project", ".pi", "example.json"));
    expect(readSettingsFile(schema, user)).toEqual({ patch: {}, errors: [] });

    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(user, JSON.stringify({ count: 3 }));

    expect(readSettingsFile(schema, user)).toEqual({ patch: { count: 3 }, errors: [] });

    writeFileSync(user, "{ nope");

    expect(readSettingsFile(schema, user).errors[0]).toContain(user);
  });

  it("applies a patch in place", () => {
    const settings: Example = { count: 1, ratio: 0.5, names: [] };

    expect(applySettings(settings, { count: 4 })).toBe(settings);
    expect(settings.count).toBe(4);
  });
});
