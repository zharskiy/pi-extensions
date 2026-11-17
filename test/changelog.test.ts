import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PI_ENTRY_LINE = "## ";
const PI_VERSION_HEADING = /##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/;
const RELEASE_PLEASE_INSERT_POINT = /\n###? v?[0-9[]/;

const readText = (path: string) => readFileSync(join(ROOT, path), "utf8");

const readJson = (path: string) => JSON.parse(readText(path));

const nextMinor = (version: string) => {
  const [major, minor] = version.split(".").map(Number);

  return `${major}.${(minor ?? 0) + 1}.0`;
};

const piVersions = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith(PI_ENTRY_LINE))
    .map((line) => PI_VERSION_HEADING.exec(line))
    .flatMap((match) => (match === null ? [] : [`${match[1]}.${match[2]}.${match[3]}`]));

const releasePleaseSection = (version: string, previous: string) =>
  [
    `## [${version}](https://github.com/zharskiy/pi-extensions/compare/v${previous}...v${version}) (2026-12-01)`,
    "",
    "",
    "### ⚠ BREAKING CHANGES",
    "",
    "* **launcher:** drop a flag ([1234567](https://github.com/zharskiy/pi-extensions/commit/1234567))",
    "",
    "### Features",
    "",
    "* **launcher:** one-step organisation installer ([89abcde](https://github.com/zharskiy/pi-extensions/commit/89abcde))",
    "",
    "### Bug Fixes",
    "",
    "* keep the receipt ([fedcba9](https://github.com/zharskiy/pi-extensions/commit/fedcba9))",
    "",
  ].join("\n");

const releasePleaseFirstSection = (version: string) =>
  `## ${version} (2026-12-01)\n\n\n### Features\n\n* a feature\n`;

const withNewSection = (changelog: string, section: string) => {
  const match = RELEASE_PLEASE_INSERT_POINT.exec(changelog);
  const at = match === null ? changelog.length : match.index + 1;

  return `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`;
};

describe("CHANGELOG.md as pi reads a package changelog", () => {
  it("ships at the package root, where pi looks without a pi.changelogPath", () => {
    const pkg = readJson("package.json");

    expect(pkg.files).toContain("CHANGELOG.md");
    expect(pkg.pi.changelogPath).toBeUndefined();
  });

  it("has a version heading pi parses for the current package version, newest first", () => {
    const versions = piVersions(readText("CHANGELOG.md"));

    expect(versions[0]).toBe(readJson("package.json").version);
  });

  it("keeps release-please's next sections readable by pi, inserted above the baseline", () => {
    const current = readJson("package.json").version;
    const next = nextMinor(current);
    const updated = withNewSection(readText("CHANGELOG.md"), releasePleaseSection(next, current));
    const first = withNewSection(readText("CHANGELOG.md"), releasePleaseFirstSection(next));

    expect(piVersions(updated)).toEqual([next, ...piVersions(readText("CHANGELOG.md"))]);
    expect(piVersions(first)[0]).toBe(next);
    expect(updated.startsWith("# Changelog\n")).toBe(true);
  });

  it("keeps release-please's subsection headings out of pi's version entries", () => {
    expect(piVersions(releasePleaseSection("0.6.0", "0.5.0"))).toEqual(["0.6.0"]);
  });
});

describe("release-please configuration", () => {
  const config = readJson("release-please-config.json");
  const root = config.packages["."];

  it("tracks the package.json version in the manifest", () => {
    expect(readJson(".release-please-manifest.json")).toEqual({ ".": readJson("package.json").version });
  });

  it("tags vX.Y.Z, writes CHANGELOG.md and bumps the bootstrap version", () => {
    expect(root["release-type"]).toBe("node");
    expect(root["include-v-in-tag"]).toBe(true);
    expect(root["include-component-in-tag"]).toBe(false);
    expect(root["changelog-path"]).toBe("CHANGELOG.md");
    expect(root["extra-files"]).toContainEqual({ type: "generic", path: "install.sh" });
    expect(readText("install.sh")).toContain(
      `bootstrap_version=${readJson("package.json").version} # x-release-please-version\n`,
    );
  });

  it("bumps the version to install in every extra file, each through a marker the generic updater reads", () => {
    const files = root["extra-files"] as { type: string; path: string }[];
    const version = /\d+\.\d+\.\d+/;
    const marked = files.map(({ path, type }) => {
      const lines = readText(path).split("\n");
      const inline = lines.filter((line) => line.includes("x-release-please-version"));
      const blocks = lines
        .map((line, index) => (line.includes("x-release-please-start-version") ? index : -1))
        .filter((index) => index >= 0)
        .map((start) => {
          const end = lines.findIndex(
            (line, index) => index > start && line.includes("x-release-please-end"),
          );

          return end < 0 ? [] : lines.slice(start + 1, end);
        });

      return {
        path,
        type,
        inline: inline.length > 0 && inline.every((line) => version.test(line)),
        blocks: blocks.every((block) => block.some((line) => version.test(line))),
        any: inline.length + blocks.length > 0,
      };
    });

    expect(files.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["README.md", "INSTALL.md", "launcher/examples/org/company-install.sh"]),
    );
    expect(marked.filter((file) => file.type !== "generic" || !file.any || !file.blocks)).toEqual([]);
    expect(
      marked.filter((file) => readText(file.path).includes("x-release-please-version") && !file.inline),
    ).toEqual([]);
  });

  it("shows what users notice and hides housekeeping", () => {
    const sections = root["changelog-sections"] as { type: string; hidden?: boolean }[];
    const shown = sections.filter((entry) => entry.hidden !== true).map((entry) => entry.type);
    const hidden = sections.filter((entry) => entry.hidden === true).map((entry) => entry.type);

    expect(shown).toEqual(expect.arrayContaining(["feat", "fix", "perf", "revert"]));
    expect(hidden).toEqual(expect.arrayContaining(["chore", "test", "docs", "refactor"]));
  });
});
