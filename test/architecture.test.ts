import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const FRAMEWORK = join(ROOT, "test-framework");
const EVALS = join(ROOT, "evals");
const EXTENSIONS = join(ROOT, "extensions");
const LAYERS = ["pi-adapter", "shared", "ui-kit", "extension-manager"].map((name) => join(ROOT, name));
const CODE_ROOTS = [...LAYERS, EXTENSIONS, FRAMEWORK, EVALS, join(ROOT, "test")];
const EXTENSION_ENTRIES = [
  "index.ts",
  "api",
  "core",
  "ui",
  "tests",
  "prompts",
  "agents",
  "README.md",
  "ARCHITECTURE.md",
  "STRUCTURE.md",
];
const MAX_DEPTH = 3;

const exists = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const extensionDirs = () =>
  readdirSync(EXTENSIONS)
    .map((name) => join(EXTENSIONS, name))
    .filter(exists);

const entriesOf = (dir: string) =>
  readdirSync(dir)
    .filter((name) => name !== "node_modules")
    .map((name) => join(dir, name));

const foldersIn = (dir: string): string[] =>
  exists(dir)
    ? entriesOf(dir)
        .filter(exists)
        .flatMap((path) => [path, ...foldersIn(path)])
    : [];

const sourceFiles = (dir: string): string[] =>
  exists(dir)
    ? entriesOf(dir).flatMap((path) => {
        if (exists(path)) {
          return sourceFiles(path);
        }

        return path.endsWith(".ts") ? [path] : [];
      })
    : [];

const allFiles = () => CODE_ROOTS.flatMap(sourceFiles);

const isInside = (dir: string) => (path: string) => path.startsWith(`${dir}${sep}`);

const specifiersOf = (file: string) =>
  [
    ...readFileSync(file, "utf8").matchAll(
      /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g,
    ),
  ]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .filter((specifier) => specifier.startsWith("."));

const importsOf = (file: string) => specifiersOf(file).map((specifier) => resolve(dirname(file), specifier));

const isNormalised = (specifier: string) => {
  const dotted = specifier.startsWith("./");
  const body = dotted ? specifier.slice(2) : specifier;

  return posix.normalize(body) === body && !(dotted && body.startsWith(".."));
};

const pluginOwner = (extension: string, plugins: string[]) => (path: string) => {
  const [area, folder, ...rest] = relative(extension, path).split(sep);

  if (area === "api" && folder === "plugins" && rest.length === 1) {
    return basename(rest[0] ?? "", ".ts");
  }

  const owned = (area === "core" || area === "ui") && plugins.includes(folder ?? "") && rest.length > 0;

  return owned ? folder : undefined;
};

const crossPluginImports = (extension: string) => {
  const pluginDir = join(extension, "api", "plugins");
  const plugins = sourceFiles(pluginDir).map((file) => basename(file, ".ts"));
  const ownerOf = pluginOwner(extension, plugins);

  return ["api", "core", "ui"]
    .flatMap((area) => sourceFiles(join(extension, area)))
    .flatMap((file) => {
      const own = ownerOf(file);

      if (own === undefined) {
        return [];
      }

      return importsOf(file)
        .filter((target) => {
          const other = ownerOf(target);

          return other !== undefined && other !== own;
        })
        .map((target) => `${relative(ROOT, file)} imports ${relative(ROOT, target)}`);
    });
};

const manifestExtensions = () =>
  (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { pi: { extensions: string[] } }).pi
    .extensions;

describe("architecture", () => {
  it("keeps each extension folder to index.ts, api, core, ui, tests, prompts, agents and its docs", () => {
    const offenders = extensionDirs()
      .flatMap(entriesOf)
      .filter((path) => !EXTENSION_ENTRIES.includes(basename(path)))
      .map((path) => relative(ROOT, path));

    expect(offenders).toEqual([]);
  });

  it("has no src folder anywhere", () => {
    const offenders = CODE_ROOTS.flatMap(foldersIn)
      .filter((dir) => basename(dir) === "src")
      .map((dir) => relative(ROOT, dir));

    expect(offenders).toEqual([]);
  });

  it(`keeps extension code at most ${MAX_DEPTH} folders below the extension`, () => {
    const offenders = extensionDirs()
      .flatMap((extension) =>
        sourceFiles(extension).filter((file) => relative(extension, file).split(sep).length - 1 > MAX_DEPTH),
      )
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it("keeps *.test.ts inside a tests/ folder and *.eval.ts inside evals/", () => {
    const offenders = allFiles()
      .filter(
        (file) =>
          (file.endsWith(".test.ts") &&
            !relative(ROOT, file).split(sep).includes("tests") &&
            !isInside(join(ROOT, "test"))(file)) ||
          (file.endsWith(".eval.ts") && !isInside(EVALS)(file)),
      )
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it("gives every layer and test-framework file a basename of its own", () => {
    const names = [...LAYERS, FRAMEWORK]
      .flatMap(sourceFiles)
      .filter((file) => !file.endsWith(".test.ts") && basename(file) !== "index.ts")
      .map((file) => basename(file));

    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("never lets a plugin import another plugin's api, core or ui code", () => {
    const offenders = extensionDirs()
      .filter((extension) => exists(join(extension, "api", "plugins")))
      .flatMap(crossPluginImports);

    expect(offenders).toEqual([]);
  });

  it("relative imports are written in normalised form so the biome path rules cannot be bypassed", () => {
    const offenders = allFiles().flatMap((file) =>
      specifiersOf(file)
        .filter((specifier) => !isNormalised(specifier))
        .map((specifier) => `${relative(ROOT, file)} imports ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it("lists exactly the extension entry files in package.json pi.extensions", () => {
    const entries = extensionDirs().map((extension) => `./${relative(ROOT, join(extension, "index.ts"))}`);

    expect([...manifestExtensions()].sort()).toEqual(entries.sort());
    expect(entries).toHaveLength(13);
  });

  it("points every pi.extensions entry at an existing extensions/<name>/index.ts", () => {
    const offenders = manifestExtensions().filter(
      (entry) => !/^\.\/extensions\/[a-z-]+\/index\.ts$/.test(entry) || !existsSync(join(ROOT, entry)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps each extension index.ts to re-exports from ./api/", () => {
    const offenders = extensionDirs()
      .map((extension) => join(extension, "index.ts"))
      .filter((file) => {
        const statements = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split(";")
          .map((statement) => statement.trim())
          .filter((statement) => statement !== "");

        return (
          statements.length === 0 ||
          !statements.every((statement) => /^export\s[^;]*\sfrom\s+"\.\/api\/[^"]+"$/.test(statement))
        );
      })
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });
});
