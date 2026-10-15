import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSettingsFiles,
  parseSettings,
  projectSettingsPath,
  readSettingsFile,
  type SettingsSchema,
  userSettingsPath,
  watchSettings,
} from "../../manager/settings.ts";
import { createFakeHost } from "../helpers/fakes.ts";

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
});

const FILE = "example.json";

const DEFAULTS: Example = { count: 5, ratio: 0.5, names: [] };

const roots: string[] = [];

const location = (projectTrusted: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "pi-core-settings-"));

  roots.push(root);

  return { agentDir: join(root, "agent"), cwd: join(root, "project"), projectTrusted };
};

const write = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
};

const withFiles = (projectTrusted: boolean) => {
  const where = location(projectTrusted);

  write(userSettingsPath(where.agentDir, FILE), { count: 2, ratio: 0.2 });
  write(projectSettingsPath(where.cwd, FILE), { ratio: 0.9 });

  return where;
};

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("settings files", () => {
  it("merges defaults, the user file and a trusted project file, project last", () => {
    expect(loadSettingsFiles(schema, DEFAULTS, FILE, withFiles(true))).toEqual({
      settings: { count: 2, ratio: 0.9, names: [] },
      errors: [],
    });
  });

  it("ignores the project file when the project is not trusted", () => {
    expect(loadSettingsFiles(schema, DEFAULTS, FILE, withFiles(false)).settings).toEqual({
      count: 2,
      ratio: 0.2,
      names: [],
    });
  });

  it("re-reads on session start and reports each invalid value once", () => {
    const where = location(false);
    const host = createFakeHost({ id: "s", ...where });
    const settings = watchSettings(host, "example", schema, DEFAULTS, FILE);
    const file = userSettingsPath(where.agentDir, FILE);

    expect(settings()).toEqual(DEFAULTS);

    write(file, { count: 3, ratio: 2 });
    host.start();
    host.start();

    expect(settings()).toEqual({ count: 3, ratio: 0.5, names: [] });
    expect(host.notices).toEqual([
      {
        message: `example settings: ${file}: ratio must be a number above 0 and at most 1`,
        level: "warning",
      },
    ]);

    write(file, { ratio: 0.8 });
    host.start();

    expect(settings()).toEqual({ count: 5, ratio: 0.8, names: [] });
  });
});
