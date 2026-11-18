import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeHost, useTempDirs } from "../../../test/framework/index.ts";
import {
  loadSettingsFiles,
  parseSettings,
  readSettingsFile,
  readSettingsFiles,
  type SettingsSchema,
  settingsPath,
} from "../../shared/index.ts";
import { reportSettingsErrors } from "../settings-errors.ts";

type Example = { count: number; ratio: number; names: string[] };

const schema: SettingsSchema<Example> = {
  count: { type: "number", min: 1, max: 10 },
  ratio: { type: "number", min: 0, max: 1, minExclusive: true },
  names: { type: "list", of: "names" },
};

const temp = useTempDirs();

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

  it("accepts only listed strings for a choice rule", () => {
    const choice: SettingsSchema<{ mode: string }> = { mode: { type: "choice", values: ["a", "b"] } };

    expect(parseSettings(choice, { mode: "b" }, "f.json").patch).toEqual({ mode: "b" });
    expect(parseSettings(choice, { mode: "c" }, "f.json").errors).toEqual([
      'f.json: mode must be one of "a", "b"',
    ]);
    expect(parseSettings(choice, { mode: 1 }, "f.json")).toEqual({
      patch: {},
      errors: ['f.json: mode must be one of "a", "b"'],
    });
  });

  it("accepts a plain object for an object rule through its own parser", () => {
    const parsed: SettingsSchema<{ map: unknown }> = {
      map: {
        type: "object",
        of: "entries",
        parse: (value) => ({ value: { kept: value.good }, errors: ["bad is wrong"] }),
      },
    };

    expect(parseSettings(parsed, { map: [] }, "f").errors).toEqual(["f: map must be an object of entries"]);
    expect(parseSettings(parsed, { map: { good: 1, bad: 2 } }, "f")).toEqual({
      patch: { map: { kept: 1 } },
      errors: ["f: map.bad is wrong"],
    });
  });

  it("rejects anything but a JSON object", () => {
    expect(parseSettings(schema, [], "f").errors).toEqual(["f: expected a JSON object"]);
    expect(parseSettings(schema, null, "f").errors).toEqual(["f: expected a JSON object"]);
  });

  it("reads files, treats a missing file as empty and reports unreadable JSON", () => {
    const root = temp.make("pi-core-settings-");
    const where = { agentDir: join(root, "agent"), cwd: join(root, "project") };
    const user = settingsPath(where, "user", "example.json");
    const project = settingsPath(where, "project", "example.json");

    expect(user).toBe(join(root, "agent", "example.json"));
    expect(project).toBe(join(root, "project", ".pi", "example.json"));
    expect(readSettingsFile(schema, user)).toEqual({ patch: {}, errors: [] });

    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(user, JSON.stringify({ count: 3 }));

    expect(readSettingsFile(schema, user)).toEqual({ patch: { count: 3 }, errors: [] });

    writeFileSync(user, "{ nope");

    expect(readSettingsFile(schema, user).errors[0]).toContain(user);
  });
});

const FILE = "example.json";

const DEFAULTS: Example = { count: 5, ratio: 0.5, names: [] };

const location = (projectTrusted: boolean) => {
  const root = temp.make("pi-core-settings-");

  return { agentDir: join(root, "agent"), cwd: join(root, "project"), projectTrusted };
};

const write = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
};

const withFiles = (projectTrusted: boolean) => {
  const where = location(projectTrusted);

  write(settingsPath(where, "user", FILE), { count: 2, ratio: 0.2 });
  write(settingsPath(where, "project", FILE), { ratio: 0.9 });

  return where;
};

describe("settings files", () => {
  it("merges defaults, the user file and a trusted project file, project last", () => {
    expect(loadSettingsFiles(schema, DEFAULTS, FILE, withFiles(true))).toEqual({
      settings: { count: 2, ratio: 0.9, names: [] },
      errors: [],
    });
  });

  it("reads the user and the trusted project values apart", () => {
    expect(readSettingsFiles(schema, FILE, withFiles(true))).toEqual({
      user: { count: 2, ratio: 0.2 },
      project: { ratio: 0.9 },
      errors: [],
    });
  });

  it("reads no project values when the project is not trusted", () => {
    expect(readSettingsFiles(schema, FILE, withFiles(false)).project).toEqual({});
  });

  it("warns about each settings error once", () => {
    const host = createFakeHost({ id: "s" });
    const report = reportSettingsErrors(host, "example");

    report(["a", "b"]);
    report(["b", "c"]);

    expect(host.notices.map((notice) => notice.message)).toEqual([
      "example settings: a",
      "example settings: b",
      "example settings: c",
    ]);
  });

  it("shares one record of reported errors per host and label, at the level given", () => {
    const host = createFakeHost({ id: "s" });

    reportSettingsErrors(host, "example")(["a"]);
    reportSettingsErrors(host, "example")(["a", "b"], "info");
    reportSettingsErrors(host, "other")(["a"]);

    expect(host.notices).toEqual([
      { message: "example settings: a", level: "warning" },
      { message: "example settings: b", level: "info" },
      { message: "other settings: a", level: "warning" },
    ]);
  });

  it("ignores the project file when the project is not trusted", () => {
    expect(loadSettingsFiles(schema, DEFAULTS, FILE, withFiles(false)).settings).toEqual({
      count: 2,
      ratio: 0.2,
      names: [],
    });
  });

  it("ignores a trusted project file of a user-only settings file and reports it", () => {
    const where = withFiles(true);
    const project = settingsPath(where, "project", FILE);
    const user = settingsPath(where, "user", FILE);

    expect(loadSettingsFiles(schema, DEFAULTS, FILE, where, "user")).toEqual({
      settings: { count: 2, ratio: 0.2, names: [] },
      errors: [`${project}: ignored, ${FILE} is read only from ${user}`],
    });
  });

  it("reports nothing for a user-only settings file without a project file", () => {
    const where = location(true);

    write(settingsPath(where, "user", FILE), { count: 3 });

    expect(loadSettingsFiles(schema, DEFAULTS, FILE, where, "user").errors).toEqual([]);
  });
});
