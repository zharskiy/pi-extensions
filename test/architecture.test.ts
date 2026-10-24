import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const ADAPTER = join(ROOT, "pi-adapter");
const SHARED = join(ROOT, "shared");
const UI_KIT = join(ROOT, "ui-kit");
const MANAGER = join(ROOT, "extension-manager");
const FRAMEWORK = join(ROOT, "test-framework");
const FRAMEWORK_PI = join(FRAMEWORK, "pi");
const EVALS = join(ROOT, "evals");
const EXTENSIONS = join(ROOT, "extensions");
const LAYERS = [ADAPTER, SHARED, UI_KIT, MANAGER];
const CODE_ROOTS = [...LAYERS, EXTENSIONS, FRAMEWORK, EVALS, join(ROOT, "test")];

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

const sourceFiles = (dir: string): string[] => {
  if (!exists(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => name !== "node_modules")
    .flatMap((name) => {
      const path = join(dir, name);

      if (statSync(path).isDirectory()) {
        return sourceFiles(path);
      }

      return path.endsWith(".ts") ? [path] : [];
    });
};

const allFiles = () => CODE_ROOTS.flatMap(sourceFiles);

const isInside = (dir: string) => (path: string) => path.startsWith(`${dir}${sep}`);

const isTestCode = (file: string) =>
  relative(ROOT, file).split(sep).includes("tests") ||
  [FRAMEWORK, EVALS, join(ROOT, "test")].some((dir) => isInside(dir)(file));

const importsOf = (file: string) =>
  [
    ...readFileSync(file, "utf8").matchAll(
      /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3]);

type Import = { file: string; specifier: string; target?: string };

const importsIn = (files: string[]): Import[] =>
  files.flatMap((file) =>
    importsOf(file).map((specifier) => ({
      file,
      specifier,
      target: specifier.startsWith(".") ? resolve(dirname(file), specifier) : undefined,
    })),
  );

const describeImport = ({ file, specifier }: Import) => `${relative(ROOT, file)} imports ${specifier}`;

const isPiPackage = (specifier: string) =>
  specifier.startsWith("@earendil-works/") || specifier === "typebox" || specifier.startsWith("typebox/");

const layerOf = (path: string) => LAYERS.find((layer) => isInside(layer)(path));

const isLayerInternal = (target: string) => {
  const layer = layerOf(target);

  return layer !== undefined && target !== join(layer, "index.ts");
};

const extensionCode = () => extensionDirs().flatMap((extension) => sourceFiles(join(extension, "src")));

const piFreeFramework = () => sourceFiles(FRAMEWORK).filter((file) => !isInside(FRAMEWORK_PI)(file));

describe("architecture", () => {
  it("only pi-adapter and test-framework/pi import pi packages", () => {
    const offenders = importsIn(allFiles())
      .filter((entry) => isPiPackage(entry.specifier))
      .filter((entry) => !isInside(ADAPTER)(entry.file) && !isInside(FRAMEWORK_PI)(entry.file))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("shipped code never imports test-framework, evals or test code", () => {
    const shipped = allFiles().filter((file) => !isTestCode(file));
    const offenders = importsIn(shipped)
      .filter((entry) => entry.target !== undefined && isTestCode(entry.target))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("pi-free test-framework modules never import test-framework/pi", () => {
    const offenders = importsIn(piFreeFramework().filter((file) => !isInside(join(FRAMEWORK, "tests"))(file)))
      .filter((entry) => entry.target !== undefined && isInside(FRAMEWORK_PI)(entry.target))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("tests reach other layers only through their index.ts, except adapter tests and test-framework/pi", () => {
    const tests = allFiles()
      .filter(isTestCode)
      .filter((file) => !isInside(join(ADAPTER, "tests"))(file) && !isInside(FRAMEWORK_PI)(file));
    const offenders = importsIn(tests)
      .filter((entry) => entry.target !== undefined && isLayerInternal(entry.target))
      .filter((entry) => layerOf(entry.target ?? "") !== layerOf(entry.file))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("test-framework never imports extensions or evals", () => {
    const offenders = importsIn(sourceFiles(FRAMEWORK))
      .filter((entry) => entry.target !== undefined)
      .filter((entry) => [EXTENSIONS, EVALS].some((dir) => isInside(dir)(entry.target ?? "")))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("plugins never import another plugin's code", () => {
    const offenders = extensionDirs()
      .map((extension) => join(extension, "src", "plugins"))
      .filter(exists)
      .flatMap((plugins) =>
        importsIn(sourceFiles(plugins))
          .filter((entry) => entry.target !== undefined && isInside(plugins)(entry.target))
          .filter((entry) => {
            const own = relative(plugins, entry.file).split(sep)[0];

            return relative(plugins, entry.target ?? "").split(sep)[0] !== own;
          })
          .map(describeImport),
      );

    expect(offenders).toEqual([]);
  });

  it("extensions never import each other", () => {
    const offenders = extensionDirs().flatMap((extension) =>
      importsIn(sourceFiles(extension))
        .filter((entry) => entry.target !== undefined && isInside(EXTENSIONS)(entry.target))
        .filter((entry) => !isInside(extension)(entry.target ?? ""))
        .map(describeImport),
    );

    expect(offenders).toEqual([]);
  });

  it("extensions reach the four layers only through their index.ts", () => {
    const offenders = importsIn(extensionCode())
      .filter((entry) => entry.target !== undefined && isLayerInternal(entry.target))
      .map(describeImport);

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

  it("lists exactly the extension entry files in package.json pi.extensions", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      pi: { extensions: string[] };
    };
    const entries = extensionDirs().map(
      (extension) => `./${relative(ROOT, join(extension, "src", "index.ts"))}`,
    );

    expect([...manifest.pi.extensions].sort()).toEqual(entries.sort());
    expect(entries).toHaveLength(13);
  });
});
