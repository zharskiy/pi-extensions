import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const ADAPTER = join(ROOT, "pi-adapter");
const ADAPTER_INDEX = join(ADAPTER, "index.ts");
const CORE_TESTS = join(ROOT, "core", "test");
const SHARED = join(ROOT, "shared");
const UI_KIT = join(ROOT, "ui-kit");
const MANAGER = join(ROOT, "extension-manager");
const LAYERS = [SHARED, UI_KIT, MANAGER];
const EXTENSIONS = join(ROOT, "extensions");

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

  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    return path.endsWith(".ts") ? [path] : [];
  });
};

const isInside = (dir: string) => (path: string) => path.startsWith(`${dir}${sep}`);

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

const layerCode = (layer: string) =>
  sourceFiles(layer).filter((file) => !isInside(join(layer, "tests"))(file));

const allLayerCode = () => LAYERS.flatMap(layerCode);

const isLayerInternal = (target: string) =>
  LAYERS.some((layer) => isInside(layer)(target) && target !== join(layer, "index.ts"));

const extensionCode = () => extensionDirs().flatMap((extension) => sourceFiles(join(extension, "src")));

const extensionTests = () => extensionDirs().flatMap((extension) => sourceFiles(join(extension, "test")));

const isPiPackage = (specifier: string) =>
  specifier.startsWith("@earendil-works/") || specifier === "typebox";

describe("architecture", () => {
  it("outside pi-adapter only pi-adapter/index.ts is imported", () => {
    const offenders = importsIn([...allLayerCode(), ...extensionCode()])
      .filter((entry) => entry.target !== undefined && isInside(ADAPTER)(entry.target))
      .filter((entry) => entry.target !== ADAPTER_INDEX)
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("extension tests reach the adapter only through pi-adapter/index.ts and core/test/adapter", () => {
    const offenders = importsIn(extensionTests())
      .filter(
        (entry) =>
          isPiPackage(entry.specifier) ||
          (entry.target !== undefined && isInside(ADAPTER)(entry.target) && entry.target !== ADAPTER_INDEX),
      )
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

  it("extensions reach shared, ui-kit and extension-manager only through their index.ts", () => {
    const offenders = extensionDirs()
      .flatMap((extension) => importsIn(sourceFiles(extension)))
      .filter((entry) => entry.target !== undefined && isLayerInternal(entry.target))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it.each([
    ["shared", SHARED, [UI_KIT, MANAGER, EXTENSIONS]],
    ["ui-kit", UI_KIT, [MANAGER, EXTENSIONS]],
    ["extension-manager", MANAGER, [UI_KIT, EXTENSIONS]],
  ])("%s never imports a layer above it", (_, layer, banned) => {
    const offenders = importsIn(sourceFiles(layer))
      .filter((entry) => entry.target !== undefined)
      .filter((entry) => banned.some((dir) => isInside(dir)(entry.target ?? "")))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("shared, ui-kit and extension-manager reach each other only through their index.ts", () => {
    const offenders = LAYERS.flatMap((layer) =>
      importsIn(sourceFiles(layer))
        .filter((entry) => entry.target !== undefined && !isInside(layer)(entry.target))
        .filter((entry) => isLayerInternal(entry.target ?? ""))
        .map(describeImport),
    );

    expect(offenders).toEqual([]);
  });

  it("pi-adapter never imports shared, ui-kit, extension-manager, core or extensions", () => {
    const offenders = importsIn(sourceFiles(ADAPTER))
      .filter((entry) => entry.target !== undefined)
      .filter((entry) => [...LAYERS, CORE_TESTS, EXTENSIONS].some((dir) => isInside(dir)(entry.target ?? "")))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("keeps every test outside src and pi-adapter, and inside tests/ of shared, ui-kit and extension-manager", () => {
    const offenders = [...extensionCode(), ...sourceFiles(ADAPTER), ...allLayerCode()]
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it("mirrors core in core/test", () => {
    const offenders = sourceFiles(CORE_TESTS)
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => relative(CORE_TESTS, file).split(sep)[0])
      .filter((area) => area !== "adapter");

    expect(offenders).toEqual([]);
  });
});
