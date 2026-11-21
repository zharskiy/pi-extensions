import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { mergeConfig } from "../../config/merge.ts";
import type { UserConfig } from "../../config/types.ts";
import { configProblem, validateConfig } from "../../config/validate.ts";
import { writeBackListing, writeBackTableOf } from "../../config/write-back.ts";
import { BUILT_IN_WRITE_BACK } from "../../shared/index.ts";

const problemOf = (writeBack: unknown) => configProblem({ writeBack });

const added = (file: string, key: string, spec: unknown) => problemOf({ add: { [file]: { [key]: spec } } });

const effective = (writeBack: UserConfig["writeBack"]) =>
  writeBackTableOf(mergeConfig(defaultConfig(), validateConfig({ writeBack })).config.writeBack);

describe("the writeBack key", () => {
  it("writes back exactly the built-in list when the config sets nothing", () => {
    expect(writeBackTableOf(defaultConfig().writeBack)).toEqual(BUILT_IN_WRITE_BACK);
    expect(Object.keys(BUILT_IN_WRITE_BACK["settings.json"] ?? {})).toHaveLength(12);
    expect(Object.keys(BUILT_IN_WRITE_BACK)).toEqual([
      "settings.json",
      "pi-subagents.json",
      "pi-style.json",
      "pi-notifications.json",
      "pi-session-limits.json",
      "pi-prune.json",
    ]);
  });

  it("accepts the documented example", () => {
    const writeBack = {
      enabled: true,
      exclude: { "settings.json": ["theme"] },
      add: {
        "settings.json": {
          editorPaddingX: { type: "integer", min: 0, max: 8 },
          defaultThinkingLevel: { type: "enum", values: ["off", "low", "high"] },
        },
        "pi-footer.json": { layout: { type: "json" } },
      },
    };

    expect(validateConfig({ writeBack })).toEqual({ writeBack });
  });

  it("drops excluded built-in keys, adds new keys and files, and overrides a built-in check in place", () => {
    const table = effective({
      exclude: { "settings.json": ["theme"], "pi-style.json": ["style"] },
      add: {
        "settings.json": {
          editorPaddingX: { type: "integer", min: 0, max: 8 },
          defaultThinkingLevel: { type: "enum", values: ["off", "turbo"] },
        },
        "pi-footer.json": { layout: { type: "json" } },
      },
    });
    const settings = Object.keys(table["settings.json"] ?? {});

    expect(settings).not.toContain("theme");
    expect(settings.at(-1)).toBe("editorPaddingX");
    expect(settings.indexOf("defaultThinkingLevel")).toBe(2);
    expect(table["settings.json"]?.defaultThinkingLevel).toEqual({ type: "enum", values: ["off", "turbo"] });
    expect(table["pi-style.json"]).toEqual({});
    expect(table["pi-footer.json"]).toEqual({ layout: { type: "json" } });
    expect(table["pi-subagents.json"]).toEqual(BUILT_IN_WRITE_BACK["pi-subagents.json"]);
  });

  it("writes nothing back when disabled", () => {
    expect(effective({ enabled: false, add: { "pi-footer.json": { layout: { type: "json" } } } })).toEqual(
      {},
    );
  });

  it("names the source of each key for pi sandbox config", () => {
    const { config, sources } = mergeConfig(defaultConfig(), {
      writeBack: { add: { "settings.json": { theme: { type: "fileName" } } } },
    });
    const listing = writeBackListing(config.writeBack);

    expect(listing["settings.json"]?.theme).toEqual({ spec: { type: "fileName" }, source: "config" });
    expect(listing["settings.json"]?.defaultModel?.source).toBe("default");
    expect(sources).toMatchObject({
      "writeBack.enabled": "default",
      "writeBack.exclude": "default",
      "writeBack.add": "config",
    });
  });
});

describe("the writeBack ceiling", () => {
  it.each(["auth.json", "models.json", "mcp.json", "mcp-auth.json", "trust.json"])(
    "never writes back %s",
    (file) => {
      expect(added(file, "x", { type: "json" })).toBe(
        `config: writeBack.add["${file}"] is never written back to the host`,
      );
    },
  );

  it.each([
    "other.json",
    "pi-.json",
    "pi-Foo.json",
    "pi-foo.yaml",
    "../pi-foo.json",
    "sub/pi-foo.json",
    "pi-sandbox/config.json",
  ])("refuses the file name %s", (file) => {
    expect(added(file, "x", { type: "json" })).toBe(
      `config: writeBack.add[${JSON.stringify(file)}] must be settings.json or a pi-<name>.json file of lowercase letters, digits and dashes`,
    );
  });

  it.each([
    "packages",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "npmCommand",
    "selfUpdateCommand",
    "shellPath",
    "shellCommandPrefix",
    "externalEditor",
    "httpProxy",
    "sessionDir",
    "defaultProjectTrust",
    "modelOverrides",
    "sessionShareDestination",
    "defaultTools",
    "enableAnalytics",
    "enableInstallTelemetry",
    "trackingId",
    "deviceId",
  ])("never writes back settings.json %s", (key) => {
    expect(added("settings.json", key, { type: "string" })).toBe(
      `config: writeBack.add["settings.json"]["${key}"] is host-owned and never written back to the host`,
    );
  });

  it("keeps disabledPlugins of pi-subagents.json on the host", () => {
    expect(added("pi-subagents.json", "disabledPlugins", { type: "json" })).toBe(
      'config: writeBack.add["pi-subagents.json"]["disabledPlugins"] is host-owned and never written back to the host',
    );
  });

  it("allows type json only in a pi-*.json file", () => {
    expect(added("settings.json", "layout", { type: "json" })).toBe(
      'config: writeBack.add["settings.json"]["layout"] uses type json, which only a pi-<name>.json file may use',
    );
    expect(
      added("settings.json", "layout", { type: "anyOf", of: [{ type: "boolean" }, { type: "json" }] }),
    ).toBe(
      'config: writeBack.add["settings.json"]["layout"] uses type json, which only a pi-<name>.json file may use',
    );
    expect(added("pi-footer.json", "layout", { type: "json" })).toBeUndefined();
  });

  it("keeps the settings.json theme a plain file name, since host pi turns it into a path", () => {
    expect(added("settings.json", "theme", { type: "string" })).toBe(
      'config: writeBack.add["settings.json"]["theme"] must use type fileName, since host pi turns it into a path',
    );
    expect(added("settings.json", "theme", { type: "fileName" })).toBeUndefined();
  });

  it("refuses a key name that is not a plain identifier", () => {
    ["", "a.b", "1a", "__proto__", "a b", "x".repeat(101)].forEach((key) => {
      expect(added("pi-footer.json", key, { type: "json" })).toMatch(/must be a key name of letters/);
    });
  });

  it("excludes only built-in keys of built-in files", () => {
    expect(problemOf({ exclude: { "settings.json": ["editorPaddingX"] } })).toBe(
      'config: writeBack.exclude["settings.json"][0] editorPaddingX is not a built-in write-back key of settings.json',
    );
    expect(problemOf({ exclude: { "pi-footer.json": ["layout"] } })).toBe(
      'config: writeBack.exclude["pi-footer.json"] is not a file of the built-in write-back list',
    );
    expect(problemOf({ exclude: { "settings.json": "theme" } })).toBe(
      'config: writeBack.exclude["settings.json"] must be an array',
    );
    expect(problemOf({ exclude: { "settings.json": ["theme"] } })).toBeUndefined();
  });

  it("refuses a key both excluded and added", () => {
    expect(
      problemOf({
        exclude: { "settings.json": ["theme"] },
        add: { "settings.json": { theme: { type: "fileName" } } },
      }),
    ).toBe("config: writeBack excludes and adds theme of settings.json");
  });

  it("refuses unknown keys and wrong shapes", () => {
    expect(problemOf({ allow: {} })).toBe("config: writeBack.allow is not a known key");
    expect(problemOf({ enabled: "yes" })).toBe("config: writeBack.enabled must be true or false");
    expect(problemOf({ add: [] })).toBe("config: writeBack.add must be an object");
    expect(problemOf({ add: { "pi-footer.json": [] } })).toBe(
      'config: writeBack.add["pi-footer.json"] must be an object',
    );
  });
});

describe("writeBack value specs", () => {
  const spec = (value: unknown) => added("pi-footer.json", "k", value);

  it.each([
    { type: "string" },
    { type: "string", maxLength: 512 },
    { type: "boolean" },
    { type: "integer", min: -1, max: 8 },
    { type: "number", min: 0.5 },
    { type: "enum", values: ["a", 1, true] },
    { type: "stringList", maxItems: 3 },
    { type: "fileName" },
    { type: "anyOf", of: [{ type: "boolean" }, { type: "enum", values: ["header"] }] },
    { type: "json" },
  ])("accepts %j", (value) => {
    expect(spec(value)).toBeUndefined();
  });

  it.each([
    [
      {},
      'writeBack.add["pi-footer.json"]["k"].type must be one of string, boolean, integer, number, enum, stringList, fileName, json, anyOf',
    ],
    [
      { type: "regex", pattern: ".*" },
      'writeBack.add["pi-footer.json"]["k"].type must be one of string, boolean, integer, number, enum, stringList, fileName, json, anyOf',
    ],
    [{ type: "string", pattern: ".*" }, 'writeBack.add["pi-footer.json"]["k"].pattern is not a known key'],
    [
      { type: "string", maxLength: 513 },
      'writeBack.add["pi-footer.json"]["k"].maxLength must be at most 512',
    ],
    [{ type: "string", maxLength: 0 }, 'writeBack.add["pi-footer.json"]["k"].maxLength must be at least 1'],
    [{ type: "integer", min: 0.5 }, 'writeBack.add["pi-footer.json"]["k"].min must be a whole number'],
    [{ type: "number", min: 2, max: 1 }, 'writeBack.add["pi-footer.json"]["k"] sets min above max'],
    [{ type: "enum" }, 'writeBack.add["pi-footer.json"]["k"].values is required'],
    [{ type: "enum", values: [] }, 'writeBack.add["pi-footer.json"]["k"].values must not be empty'],
    [
      { type: "enum", values: [null] },
      'writeBack.add["pi-footer.json"]["k"].values[0] must be a string, a number or true or false',
    ],
    [
      { type: "enum", values: ["x".repeat(513)] },
      'writeBack.add["pi-footer.json"]["k"].values[0] must be at most 512 characters',
    ],
    [{ type: "stringList", maxItems: 0 }, 'writeBack.add["pi-footer.json"]["k"].maxItems must be at least 1'],
    [{ type: "anyOf", of: [] }, 'writeBack.add["pi-footer.json"]["k"].of must not be empty'],
    [
      { type: "anyOf", of: [{ type: "nope" }] },
      'writeBack.add["pi-footer.json"]["k"].of[0].type must be one of string, boolean, integer, number, enum, stringList, fileName, json, anyOf',
    ],
    ["json", 'writeBack.add["pi-footer.json"]["k"] must be an object'],
  ])("refuses %j", (value, message) => {
    expect(spec(value)).toBe(`config: ${message}`);
  });

  it("accepts anyOf nested 4 levels deep and refuses a fifth level, naming its path", () => {
    const nested = (levels: number): unknown =>
      levels === 0 ? { type: "boolean" } : { type: "anyOf", of: [nested(levels - 1)] };

    expect(spec(nested(4))).toBeUndefined();
    expect(spec(nested(5))).toBe(
      'config: writeBack.add["pi-footer.json"]["k"].of[0].of[0].of[0].of[0] nests anyOf more than 4 levels deep',
    );
    expect(spec(nested(2000))).toBe(
      'config: writeBack.add["pi-footer.json"]["k"].of[0].of[0].of[0].of[0] nests anyOf more than 4 levels deep',
    );
  });
});
