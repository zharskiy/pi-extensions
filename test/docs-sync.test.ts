import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const EXTENSION_DOCS = ["README.md", "ARCHITECTURE.md", "STRUCTURE.md"];
const ROOT_DOCS = ["ARCHITECTURE.md", "STRUCTURE.md"];
const EXTENSION_PATH = /^extensions\/([^/]+)\/(.+)$/;

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

const isCode = (name: string) => (path: string) => {
  const match = EXTENSION_PATH.exec(path);

  return match?.[1] === name && !EXTENSION_DOCS.includes(match[2] ?? "");
};

const docsOf = (name: string) => [...EXTENSION_DOCS.map((doc) => `extensions/${name}/${doc}`), ...ROOT_DOCS];

const missingDocs = (changed: string[]): Gap[] => {
  const names = [
    ...new Set(changed.map((path) => EXTENSION_PATH.exec(path)?.[1]).filter((name) => name !== undefined)),
  ];

  return names
    .sort()
    .map((name) => ({
      extension: `extensions/${name}`,
      triggers: changed.filter(isCode(name)).sort(),
      missing: docsOf(name).filter((doc) => !changed.includes(doc)),
    }))
    .filter((gap) => gap.triggers.length > 0 && gap.missing.length > 0);
};

const report = (gaps: Gap[]) =>
  [
    "Extension code changed without its docs. Update the listed docs:",
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

  it("ignores changes under platform/ or test/", () => {
    expect(missingDocs(["platform/shared/index.ts", "test/architecture.test.ts"])).toEqual([]);
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

  it("treats a new untracked file as code of its extension", () => {
    const changed = ["extensions/footer/ui/new-widget.ts", ...docsOf("footer").slice(1)];

    expect(missingDocs(changed)).toEqual([
      {
        extension: "extensions/footer",
        triggers: ["extensions/footer/ui/new-widget.ts"],
        missing: ["extensions/footer/README.md"],
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
  it("updates the docs of every extension whose code changed since the base commit", () => {
    const gaps = missingDocs(changedPaths());

    expect(gaps, report(gaps)).toEqual([]);
  });
});
