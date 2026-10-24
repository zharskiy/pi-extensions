import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const ADAPTER = join(ROOT, "pi-adapter");
const ADAPTER_INDEX = join(ADAPTER, "index.ts");
const CORE = join(ROOT, "core");
const MANAGER = join(CORE, "manager");
const CORE_TESTS = join(CORE, "test");
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

const coreCode = () => sourceFiles(CORE).filter((file) => !isInside(CORE_TESTS)(file));

const extensionCode = () => extensionDirs().flatMap((extension) => sourceFiles(join(extension, "src")));

const extensionTests = () => extensionDirs().flatMap((extension) => sourceFiles(join(extension, "test")));

const isPiPackage = (specifier: string) =>
  specifier.startsWith("@earendil-works/") || specifier === "typebox";

describe("architecture", () => {
  it("outside pi-adapter only pi-adapter/index.ts is imported", () => {
    const offenders = importsIn([...coreCode(), ...extensionCode()])
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

  it("core never imports from extensions", () => {
    const offenders = importsIn(sourceFiles(CORE))
      .filter((entry) => entry.target !== undefined && isInside(EXTENSIONS)(entry.target))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("pi-adapter never imports core or extensions", () => {
    const offenders = importsIn(sourceFiles(ADAPTER))
      .filter((entry) => entry.target !== undefined)
      .filter((entry) => isInside(CORE)(entry.target ?? "") || isInside(EXTENSIONS)(entry.target ?? ""))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("keeps every test outside src, pi-adapter and core/manager", () => {
    const offenders = [...extensionCode(), ...sourceFiles(ADAPTER), ...sourceFiles(MANAGER)]
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it("mirrors core in core/test", () => {
    const offenders = sourceFiles(CORE_TESTS)
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => relative(CORE_TESTS, file).split(sep)[0])
      .filter((area) => !["adapter", "manager"].includes(area));

    expect(offenders).toEqual([]);
  });
});
