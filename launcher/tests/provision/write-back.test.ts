import { describe, expect, it } from "vitest";
import {
  applyChanges,
  baselineRecord,
  changeLine,
  EXTENSION_FILES,
  mergeFile,
  parseBaseline,
  parseVolumeText,
  SETTINGS_FILE,
  SYNCED_FILES,
  syncedValues,
} from "../../provision/write-back.ts";

const fileNamed = (name: string) => {
  const found = SYNCED_FILES.find((file) => file.name === name);

  if (found === undefined) {
    throw new Error(`no synced file ${name}`);
  }

  return found;
};

const SUBAGENTS = fileNamed("pi-subagents.json");

describe("the write-back allowlist", () => {
  it("names plain settings.json preferences only, never code, paths, URLs or credentials", () => {
    const forbidden = [
      "packages",
      "extensions",
      "skills",
      "prompts",
      "themes",
      "npmCommand",
      "shellPath",
      "shellCommandPrefix",
      "externalEditor",
      "selfUpdateCommand",
      "defaultProjectTrust",
      "modelOverrides",
      "sessionShareDestination",
      "httpProxy",
      "sessionDir",
    ];

    expect(SETTINGS_FILE.keys.filter((key) => forbidden.includes(key))).toEqual([]);
    expect(SETTINGS_FILE.keys).toContain("defaultModel");
  });

  it("covers the four extension files, 64 KiB each, and keeps disabledPlugins on the host", () => {
    expect(EXTENSION_FILES.map((file) => [file.name, file.maxBytes])).toEqual([
      ["pi-subagents.json", 65_536],
      ["pi-style.json", 65_536],
      ["pi-notifications.json", 65_536],
      ["pi-session-limits.json", 65_536],
    ]);
    expect(SUBAGENTS.keys).not.toContain("disabledPlugins");
  });

  it("picks the allowlisted keys of an object and nothing else", () => {
    expect(syncedValues(SETTINGS_FILE, { theme: "dark", packages: ["npm:a"], shellPath: "/bin/sh" })).toEqual(
      {
        theme: "dark",
      },
    );
    expect(syncedValues(SETTINGS_FILE, undefined)).toEqual({});
  });
});

describe("mergeFile", () => {
  const merge = (baseline: object, volume: object, host: object) =>
    mergeFile(SETTINGS_FILE, { baseline, volume, host } as never);

  it("does nothing when the sandbox left a key as the sync wrote it", () => {
    expect(merge({ theme: "a" }, { theme: "a" }, { theme: "b" })).toEqual({ changes: [], notices: [] });
  });

  it("does nothing when the host already holds the sandbox value", () => {
    expect(merge({ theme: "a" }, { theme: "b" }, { theme: "b" })).toEqual({ changes: [], notices: [] });
  });

  it("writes the sandbox value when only the sandbox changed the key", () => {
    expect(merge({ theme: "a" }, { theme: "b" }, { theme: "a" })).toEqual({
      changes: [{ key: "theme", from: "a", to: "b" }],
      notices: [],
    });
  });

  it("keeps the host value with a notice when both sides changed the key", () => {
    expect(merge({ theme: "a" }, { theme: "b" }, { theme: "c" })).toEqual({
      changes: [],
      notices: ["settings.json: theme changed on the host and in the sandbox; kept the host value"],
    });
  });

  it("counts a key deleted in the sandbox as a change, and one added there too", () => {
    expect(merge({ theme: "a" }, {}, { theme: "a" }).changes).toEqual([
      { key: "theme", from: "a", to: undefined },
    ]);
    expect(merge({}, { theme: "b" }, {}).changes).toEqual([{ key: "theme", from: undefined, to: "b" }]);
  });

  it("ignores keys outside the allowlist, whatever the sandbox wrote", () => {
    const planted = { packages: ["npm:evil"], shellPath: "/tmp/sh", npmCommand: ["sh", "-c", "x"] };

    expect(merge({}, planted, {})).toEqual({ changes: [], notices: [] });
  });

  it("compares nested values by deep JSON equality", () => {
    const baseline = { maxDepth: 3, agents: { scout: { model: "p/m", skills: ["a"] } } };
    const same = { maxDepth: 3, agents: { scout: { skills: ["a"], model: "p/m" } } };
    const changed = { maxDepth: 3, agents: { scout: { model: "p/m", skills: ["a", "b"] } } };
    const sides = (volume: object) => ({ baseline, volume, host: baseline }) as never;

    expect(mergeFile(SUBAGENTS, sides(same)).changes).toEqual([]);
    expect(mergeFile(SUBAGENTS, sides(changed)).changes).toEqual([
      { key: "agents", from: baseline.agents, to: changed.agents },
    ]);
  });
});

describe("checking settings.json values from the sandbox", () => {
  const written = (key: string, value: unknown) =>
    mergeFile(SETTINGS_FILE, { baseline: {}, volume: { [key]: value }, host: {} } as never);
  const accepted = (key: string, value: unknown) => written(key, value).changes.length === 1;

  it("gives every allowlisted settings.json key a check", () => {
    expect(Object.keys(SETTINGS_FILE.checks ?? {}).sort()).toEqual([...SETTINGS_FILE.keys].sort());
  });

  it("drops a value of the wrong type with a notice", () => {
    expect(written("enabledModels", [1])).toEqual({
      changes: [],
      notices: ["settings.json: enabledModels in the sandbox is not a valid value; not written back"],
    });
  });

  it.each([
    ["defaultProvider", "provider", 7],
    ["defaultModel", "provider/model", "x".repeat(513)],
    ["enabledModels", ["p/a", "p/b"], "p/a"],
    ["hideThinkingBlock", true, "true"],
    ["collapseChangelog", false, 0],
    ["quietStartup", "header", "loud"],
    ["quietStartup", true, null],
    ["defaultThinkingLevel", "xhigh", "extreme"],
    ["defaultThinkingLevel", "off", false],
    ["steeringMode", "one-at-a-time", "two"],
    ["followUpMode", "all", ["all"]],
    ["doubleEscapeAction", "tree", "exit"],
    ["treeFilterMode", "labeled-only", "labelled"],
    ["theme", "my-theme_2.dark", "../../../../tmp/evil"],
  ])("accepts %s %j and drops %j", (key, good, bad) => {
    expect(accepted(key, good)).toBe(true);
    expect(accepted(key, bad)).toBe(false);
  });

  it("accepts a theme only as a plain file name", () => {
    expect(
      [".", "..", "a/b", "a\\b", "", "dark theme", "x".repeat(513)].filter((name) => accepted("theme", name)),
    ).toEqual([]);
    expect(accepted("theme", "...")).toBe(true);
  });

  it("always lets the sandbox unset a key", () => {
    expect(
      mergeFile(SETTINGS_FILE, { baseline: { theme: "a" }, volume: {}, host: { theme: "a" } } as never)
        .changes,
    ).toEqual([{ key: "theme", from: "a", to: undefined }]);
  });

  it("leaves pi-*.json values to the extension's own schema", () => {
    expect(
      mergeFile(SUBAGENTS, { baseline: {}, volume: { maxDepth: "deep" }, host: {} } as never).changes,
    ).toEqual([{ key: "maxDepth", from: undefined, to: "deep" }]);
  });
});

describe("applyChanges", () => {
  it("keeps every host-only key and the key order, removes deleted keys and appends new ones", () => {
    const host = { packages: ["npm:a"], theme: "a", defaultModel: "m", shellPath: "/bin/zsh" };
    const applied = applyChanges(host, [
      { key: "theme", from: "a", to: "b" },
      { key: "defaultModel", from: "m", to: undefined },
      { key: "quietStartup", from: undefined, to: true },
    ]);

    expect(applied).toEqual({ packages: ["npm:a"], theme: "b", shellPath: "/bin/zsh", quietStartup: true });
    expect(Object.keys(applied)).toEqual(["packages", "theme", "shellPath", "quietStartup"]);
  });
});

describe("parseVolumeText", () => {
  it("skips a missing file without a notice, so none of its keys reads as deleted", () => {
    expect(parseVolumeText(SETTINGS_FILE, undefined)).toEqual({ notices: [] });
  });

  it("skips a file that is not a JSON object with a notice", () => {
    expect(parseVolumeText(SUBAGENTS, "[1, 2]")).toEqual({
      notices: ["pi-subagents.json in the sandbox is not a JSON object; not written back"],
    });
    expect(parseVolumeText(SUBAGENTS, "{ broken")).toEqual({
      notices: ["pi-subagents.json in the sandbox is not a JSON object; not written back"],
    });
  });

  it("skips a file larger than its limit with a notice", () => {
    const text = JSON.stringify({ agents: { big: "x".repeat(70_000) } });

    expect(parseVolumeText(SUBAGENTS, text)).toEqual({
      notices: ["pi-subagents.json in the sandbox is larger than 64 KiB; not written back"],
    });
  });
});

describe("parseBaseline", () => {
  it("round-trips a record of every synced file, keeping allowlisted keys only", () => {
    const files = Object.fromEntries(SYNCED_FILES.map((file) => [file.name, {}]));
    const recorded = baselineRecord({ ...files, "settings.json": { theme: "a", packages: [] } });

    expect(parseBaseline(JSON.parse(JSON.stringify(recorded)))).toEqual({
      ...files,
      "settings.json": { theme: "a" },
    });
  });

  it("treats a missing, malformed or partial baseline as none", () => {
    expect(parseBaseline(undefined)).toBeUndefined();
    expect(parseBaseline({ files: [] })).toBeUndefined();
    expect(parseBaseline({ files: { "settings.json": {} } })).toBeUndefined();
  });
});

describe("changeLine", () => {
  it("names the file, key and both values", () => {
    expect(changeLine(SETTINGS_FILE, { key: "defaultModel", from: "x", to: "y" })).toBe(
      "settings.json defaultModel: x → y written to the host",
    );
    expect(changeLine(SETTINGS_FILE, { key: "theme", from: undefined, to: undefined })).toBe(
      "settings.json theme: (unset) → (unset) written to the host",
    );
  });

  it("truncates long values and replaces control characters", () => {
    const line = changeLine(SUBAGENTS, { key: "agents", from: {}, to: { long: "y".repeat(100) } });

    expect(line).toBe(`pi-subagents.json agents: {} → {"long":"${"y".repeat(50)}… written to the host`);
    expect(changeLine(SETTINGS_FILE, { key: "theme", from: "a", to: "\u001b[2Jx\u009b" })).toBe(
      "settings.json theme: a → ?[2Jx? written to the host",
    );
  });

  it("replaces bidi controls and line and paragraph separators", () => {
    const planted = "a\u202ab\u202ec\u2066d\u2069e\u2028f\u2029g";

    expect(changeLine(SUBAGENTS, { key: "agents", from: undefined, to: planted })).toBe(
      "pi-subagents.json agents: (unset) → a?b?c?d?e?f?g written to the host",
    );
  });
});
