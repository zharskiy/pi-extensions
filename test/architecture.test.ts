import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const TEST = join(ROOT, "test");
const FRAMEWORK = join(TEST, "framework");
const EVALS = join(TEST, "evals");
const EXTENSIONS = join(ROOT, "extensions");
const LAYERS = ["pi-adapter", "shared", "ui-kit", "extension-manager"].map((name) =>
  join(ROOT, "platform", name),
);
const LAUNCHER = join(ROOT, "launcher");
const LAUNCHER_ENTRY_FOLDERS = ["bin"];
const LAUNCHER_BUILD = "dist";
const LAUNCHER_ENTRY_TARGETS = [
  join(LAUNCHER, "cli", "main.ts"),
  join(LAUNCHER, LAUNCHER_BUILD, "cli", "main.js"),
];
const LAUNCHER_TEST_PACKAGES = ["vitest"];
const PI_PACKAGE_REFERENCE =
  /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*|\.resolve\s*\(\s*)["'`](?:@earendil-works\/|typebox["'`/])/;
const LAUNCHER_PI_ASSET = /^hostpi\/[^/]+\.mjs$/;
const LAUNCHER_TESTS = "tests";
const LAUNCHER_TEST_SUPPORT = "support";
const LAUNCHER_GRAPH: Record<string, string[]> = {
  shared: [],
  config: ["shared"],
  workspace: ["config", "shared"],
  backend: ["shared"],
  proxy: ["config", "grants", "shared"],
  container: ["backend", "config", "shared", "workspace"],
  image: ["backend", "config", "shared"],
  hostpi: ["config", "shared"],
  grants: ["shared"],
  provision: ["backend", "config", "hostpi", "shared"],
  cli: ["backend", "config", "container", "image", "proxy", "shared", "workspace"],
  bin: ["cli"],
};
const CODE_ROOTS = [...LAYERS, EXTENSIONS, TEST, LAUNCHER];
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

const allSpecifiersOf = (file: string) =>
  [
    ...readFileSync(file, "utf8").matchAll(
      /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

const specifiersOf = (file: string) => allSpecifiersOf(file).filter((specifier) => specifier.startsWith("."));

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

const launcherFiles = (dir: string): string[] =>
  exists(dir)
    ? entriesOf(dir).flatMap((path) => {
        if (path === join(LAUNCHER, LAUNCHER_BUILD)) {
          return [];
        }

        if (exists(path)) {
          return launcherFiles(path);
        }

        return /\.(m?js|ts)$/.test(path) ? [path] : [];
      })
    : [];

const launcherFolderOf = (path: string) => relative(LAUNCHER, path).split(sep)[0] ?? "";

const isLauncherTest = (file: string) => launcherFolderOf(file) === "tests";

const isLauncherPiAsset = (file: string) =>
  LAUNCHER_PI_ASSET.test(relative(LAUNCHER, file).split(sep).join("/"));

const launcherPiReferences = (files: Array<{ path: string; text: string }>) =>
  files
    .filter((file) => !isLauncherPiAsset(file.path) && PI_PACKAGE_REFERENCE.test(file.text))
    .map((file) => relative(ROOT, file.path));

const isAllowedLauncherSpecifier = (file: string) => (specifier: string) => {
  if (specifier.startsWith("node:")) {
    return true;
  }

  if (isLauncherPiAsset(file) && PI_PACKAGE_REFERENCE.test(`from "${specifier}"`)) {
    return true;
  }

  if (specifier.startsWith(".")) {
    return isInside(LAUNCHER)(resolve(dirname(file), specifier));
  }

  return isLauncherTest(file) && LAUNCHER_TEST_PACKAGES.includes(specifier);
};

const launcherTestFolderOf = (path: string) =>
  relative(join(LAUNCHER, LAUNCHER_TESTS), path).split(sep)[0] ?? "";

const isLauncherIndex = (target: string) => target === join(LAUNCHER, launcherFolderOf(target), "index.ts");

const isInnerLauncherImport = (file: string) => (target: string) => {
  const from = launcherFolderOf(file);
  const to = launcherFolderOf(target);

  if (from === LAUNCHER_TESTS) {
    return to !== LAUNCHER_TESTS && to !== launcherTestFolderOf(file) && !isLauncherIndex(target);
  }

  if (LAUNCHER_ENTRY_FOLDERS.includes(from)) {
    return !LAUNCHER_ENTRY_TARGETS.includes(target);
  }

  return from !== to && !isLauncherIndex(target);
};

const shippedLauncherFiles = () => launcherFiles(LAUNCHER).filter((file) => !isLauncherTest(file));

const launcherEdges = () =>
  shippedLauncherFiles().flatMap((file) => {
    const from = launcherFolderOf(file);

    return importsOf(file)
      .map(launcherFolderOf)
      .filter((to) => to !== from && to !== LAUNCHER_BUILD)
      .map((to) => ({ from, to }));
  });

const launcherGraph = () => {
  const edges = launcherEdges();
  const folders = [...new Set(shippedLauncherFiles().map(launcherFolderOf))];

  return Object.fromEntries(
    folders.map((from) => [
      from,
      [...new Set(edges.filter((edge) => edge.from === from).map((edge) => edge.to))].sort(),
    ]),
  );
};

const testImportsOfOtherTestFolders = (file: string) => {
  const own = launcherTestFolderOf(file);

  return importsOf(file).filter((target) => {
    const folder = launcherTestFolderOf(target);

    return (
      launcherFolderOf(target) === LAUNCHER_TESTS &&
      own === LAUNCHER_TEST_SUPPORT &&
      folder !== LAUNCHER_TEST_SUPPORT
    );
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

  it(`keeps extension and platform layer code at most ${MAX_DEPTH} folders below its own root`, () => {
    const offenders = [...extensionDirs(), ...LAYERS]
      .flatMap((unit) =>
        sourceFiles(unit).filter((file) => relative(unit, file).split(sep).length - 1 > MAX_DEPTH),
      )
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it("keeps *.test.ts inside a tests/ folder and *.eval.ts inside test/evals/", () => {
    const offenders = allFiles()
      .filter(
        (file) =>
          (file.endsWith(".test.ts") &&
            !relative(ROOT, file).split(sep).includes("tests") &&
            dirname(file) !== TEST) ||
          (file.endsWith(".eval.ts") && !isInside(EVALS)(file)),
      )
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it("gives every platform layer and test/framework file a basename of its own", () => {
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

  it("keeps launcher/ standalone: node built-ins and launcher files only, vitest in its tests", () => {
    const offenders = launcherFiles(LAUNCHER).flatMap((file) =>
      allSpecifiersOf(file)
        .filter((specifier) => !isAllowedLauncherSpecifier(file)(specifier))
        .map((specifier) => `${relative(ROOT, file)} imports ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it("lets only launcher/hostpi/*.mjs reference a pi package anywhere under launcher/", () => {
    const files = launcherFiles(LAUNCHER).map((path) => ({ path, text: readFileSync(path, "utf8") }));

    expect(launcherPiReferences(files)).toEqual([]);
  });

  it("flags a launcher file other than a hostpi .mjs asset that references a pi package", () => {
    const reference = 'createRequire(root).resolve("@earendil-works/pi-ai/providers/all")';
    const files = [
      { path: join(LAUNCHER, "hostpi", "provider-hosts.mjs"), text: reference },
      { path: join(LAUNCHER, "hostpi", "derive.ts"), text: reference },
      {
        path: join(LAUNCHER, "proxy", "helper.mjs"),
        text: `import x from "@earendil-works/pi-coding-agent";`,
      },
      { path: join(LAUNCHER, "hostpi", "nested", "deep.mjs"), text: "import 'typebox';" },
      {
        path: join(LAUNCHER, "cli", "versions.ts"),
        text: 'const PI_PACKAGE = "@earendil-works/pi-coding-agent";',
      },
      { path: join(LAUNCHER, "cli", "late.ts"), text: 'await import("@earendil-works/pi-coding-agent");' },
    ];

    expect(launcherPiReferences(files)).toEqual([
      "launcher/hostpi/derive.ts",
      "launcher/proxy/helper.mjs",
      "launcher/hostpi/nested/deep.mjs",
      "launcher/cli/late.ts",
    ]);
  });

  it("lets a launcher folder, or a test folder other than its own, reach a launcher folder only through its index.ts, and bin/ only cli/main", () => {
    const offenders = launcherFiles(LAUNCHER).flatMap((file) =>
      importsOf(file)
        .filter(isInnerLauncherImport(file))
        .map((target) => `${relative(ROOT, file)} imports ${relative(ROOT, target)}`),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the launcher folder graph to exactly the documented edges", () => {
    expect(launcherGraph()).toEqual(LAUNCHER_GRAPH);
  });

  it("never lets shipped launcher code import launcher/tests/", () => {
    const offenders = shippedLauncherFiles().flatMap((file) =>
      importsOf(file)
        .filter((target) => launcherFolderOf(target) === LAUNCHER_TESTS)
        .map((target) => `${relative(ROOT, file)} imports ${relative(ROOT, target)}`),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps launcher/tests/support/ free of imports from the per-folder test suites", () => {
    const offenders = launcherFiles(join(LAUNCHER, LAUNCHER_TESTS)).flatMap((file) =>
      testImportsOfOtherTestFolders(file).map(
        (target) => `${relative(ROOT, file)} imports ${relative(ROOT, target)}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it("lists exactly the extension entry files in package.json pi.extensions", () => {
    const entries = extensionDirs().map((extension) => `./${relative(ROOT, join(extension, "index.ts"))}`);

    expect([...manifestExtensions()].sort()).toEqual(entries.sort());
    expect(entries).toHaveLength(14);
    expect(entries.filter((entry) => !/^\.\/extensions\/[a-z-]+\/index\.ts$/.test(entry))).toEqual([]);
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
