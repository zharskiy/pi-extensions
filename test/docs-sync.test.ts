import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const EXTENSION_DOCS = ["README.md", "ARCHITECTURE.md", "STRUCTURE.md"];
const ROOT_DOCS = ["ARCHITECTURE.md", "STRUCTURE.md"];
const UNIT_PATH = /^(extensions\/[^/]+|launcher)\/(.+)$/;

type Gap = { extension: string; triggers: string[]; missing: string[] };

const git = (...args: string[]) => {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

const lines = (text: string | undefined) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const baseCommit = () =>
  process.env.DOCS_SYNC_BASE || git("merge-base", "HEAD", "origin/main") || git("merge-base", "HEAD", "main");

const changedPaths = () => {
  const base = baseCommit();

  if (!base) {
    return [];
  }

  const diffed = lines(git("diff", "--name-only", "--no-renames", base));
  const untracked = lines(git("ls-files", "--others", "--exclude-standard"));

  return [...new Set([...diffed, ...untracked])];
};

const isCode = (unit: string) => (path: string) => {
  const match = UNIT_PATH.exec(path);

  const rest = match?.[2] ?? "";

  return match?.[1] === unit && !EXTENSION_DOCS.includes(rest) && !rest.startsWith("tests/");
};

const unitDocs = (unit: string) => [...EXTENSION_DOCS.map((doc) => `${unit}/${doc}`), ...ROOT_DOCS];

const docsOf = (name: string) => unitDocs(`extensions/${name}`);

const missingDocs = (changed: string[]): Gap[] => {
  const units = [
    ...new Set(changed.map((path) => UNIT_PATH.exec(path)?.[1]).filter((unit) => unit !== undefined)),
  ];

  return units
    .sort()
    .map((unit) => ({
      extension: unit,
      triggers: changed.filter(isCode(unit)).sort(),
      missing: unitDocs(unit).filter((doc) => !changed.includes(doc)),
    }))
    .filter((gap) => gap.triggers.length > 0 && gap.missing.length > 0);
};

const report = (gaps: Gap[]) =>
  [
    "Extension or launcher code changed without its docs. Update the listed docs:",
    ...gaps.map((gap) =>
      [
        gap.extension,
        "  changed code:",
        ...gap.triggers.map((path) => `    ${path}`),
        "  docs to update:",
        ...gap.missing.map((path) => `    ${path}`),
      ].join("\n"),
    ),
  ].join("\n");

describe("docs sync rule", () => {
  it("finds nothing when nothing changed", () => {
    expect(missingDocs([])).toEqual([]);
  });

  it("ignores doc-only changes in an extension", () => {
    expect(missingDocs(["extensions/footer/README.md"])).toEqual([]);
  });

  it("accepts a code change when every doc changed too", () => {
    expect(missingDocs(["extensions/footer/index.ts", ...docsOf("footer")])).toEqual([]);
  });

  it("reports a missing extension doc", () => {
    const changed = ["extensions/footer/index.ts", ...docsOf("footer")].filter(
      (path) => path !== "extensions/footer/STRUCTURE.md",
    );

    expect(missingDocs(changed)).toEqual([
      {
        extension: "extensions/footer",
        triggers: ["extensions/footer/index.ts"],
        missing: ["extensions/footer/STRUCTURE.md"],
      },
    ]);
  });

  it("reports a missing root spec", () => {
    const changed = ["extensions/footer/index.ts", ...docsOf("footer")].filter(
      (path) => path !== "ARCHITECTURE.md",
    );

    expect(missingDocs(changed)).toEqual([
      {
        extension: "extensions/footer",
        triggers: ["extensions/footer/index.ts"],
        missing: ["ARCHITECTURE.md"],
      },
    ]);
  });

  it("reports only the incomplete extension of two", () => {
    const changed = [
      "extensions/footer/index.ts",
      ...docsOf("footer"),
      "extensions/spending/api/index.ts",
      "extensions/spending/README.md",
    ];

    expect(missingDocs(changed)).toEqual([
      {
        extension: "extensions/spending",
        triggers: ["extensions/spending/api/index.ts"],
        missing: ["extensions/spending/ARCHITECTURE.md", "extensions/spending/STRUCTURE.md"],
      },
    ]);
  });

  it("treats launcher/ as one unit with its own docs", () => {
    expect(missingDocs(["launcher/shared/errors.ts", "launcher/README.md", "STRUCTURE.md"])).toEqual([
      {
        extension: "launcher",
        triggers: ["launcher/shared/errors.ts"],
        missing: ["launcher/ARCHITECTURE.md", "launcher/STRUCTURE.md", "ARCHITECTURE.md"],
      },
    ]);
  });

  it("ignores changes under platform/ or test/", () => {
    expect(missingDocs(["platform/shared/index.ts", "test/architecture.test.ts"])).toEqual([]);
  });

  it("ignores test-only changes in an extension or the launcher", () => {
    expect(
      missingDocs(["extensions/footer/tests/segments.test.ts", "launcher/tests/cli/launch.test.ts"]),
    ).toEqual([]);
  });

  it("names only the shipped code when tests changed with it", () => {
    expect(missingDocs(["launcher/shared/errors.ts", "launcher/tests/shared/errors.test.ts"])).toEqual([
      {
        extension: "launcher",
        triggers: ["launcher/shared/errors.ts"],
        missing: unitDocs("launcher"),
      },
    ]);
  });

  it("treats a nested path as code of its extension", () => {
    expect(missingDocs(["extensions/footer/core/segments.ts"])).toEqual([
      {
        extension: "extensions/footer",
        triggers: ["extensions/footer/core/segments.ts"],
        missing: docsOf("footer"),
      },
    ]);
  });

  it("names every trigger and missing doc in the report", () => {
    const text = report(missingDocs(["extensions/footer/core/segments.ts"]));

    expect(text).toContain("extensions/footer/core/segments.ts");
    expect(docsOf("footer").every((doc) => text.includes(doc))).toBe(true);
  });
});

describe("docs sync", () => {
  it("updates the docs of every extension and of the launcher whose code changed since the base commit", () => {
    const gaps = missingDocs(changedPaths());

    expect(gaps, report(gaps)).toEqual([]);
  });
});
