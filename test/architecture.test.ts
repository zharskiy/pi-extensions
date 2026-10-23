import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const CORE = join(ROOT, "core");
const ADAPTER = join(CORE, "adapter");
const MANAGER = join(CORE, "manager");
const CORE_TESTS = join(CORE, "test");
const EXTENSIONS = join(ROOT, "extensions");
const SHARED = join(ROOT, "shared");
const SHARED_TESTS = join(SHARED, "test");
const CONTRACT = join(ADAPTER, "contract.ts");
const PI_ADAPTER = join(ADAPTER, "pi-adapter.ts");

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

const sharedCode = () => sourceFiles(SHARED).filter((file) => !isInside(SHARED_TESTS)(file));

const extensionTests = () => extensionDirs().flatMap((extension) => sourceFiles(join(extension, "test")));

const isPiPackage = (specifier: string) =>
  specifier.startsWith("@earendil-works/") || specifier === "typebox";

const isEntry = (file: string) =>
  extensionDirs().some((extension) => file === join(extension, "src", "index.ts"));

describe("architecture", () => {
  it("outside core/adapter only the contract is imported, except pi-adapter by each extension's entry", () => {
    const offenders = importsIn([...coreCode(), ...extensionCode(), ...sharedCode()])
      .filter((entry) => !isInside(ADAPTER)(entry.file))
      .filter((entry) => entry.target !== undefined && isInside(ADAPTER)(entry.target))
      .filter((entry) => entry.target !== CONTRACT)
      .filter((entry) => !(entry.target === PI_ADAPTER && isEntry(entry.file)))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("extension and shared tests reach the adapter only through the contract and core/test/adapter", () => {
    const offenders = importsIn([...extensionTests(), ...sourceFiles(SHARED_TESTS)])
      .filter(
        (entry) =>
          isPiPackage(entry.specifier) ||
          (entry.target !== undefined && isInside(ADAPTER)(entry.target) && entry.target !== CONTRACT),
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

  it("shared code imports only itself, the contract and core/manager", () => {
    const offenders = importsIn(sharedCode())
      .filter(
        (entry) =>
          entry.target === undefined ||
          !(isInside(SHARED)(entry.target) || entry.target === CONTRACT || isInside(MANAGER)(entry.target)),
      )
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("core/manager never imports shared", () => {
    const offenders = importsIn(sourceFiles(MANAGER))
      .filter((entry) => entry.target !== undefined && isInside(SHARED)(entry.target))
      .map(describeImport);

    expect(offenders).toEqual([]);
  });

  it("keeps shared tests in shared/test", () => {
    const offenders = sharedCode()
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  it("keeps every test outside src, core/adapter and core/manager", () => {
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
