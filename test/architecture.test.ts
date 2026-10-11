import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSIONS = join(import.meta.dirname, "..", "extensions");

const extensionDirs = () =>
  readdirSync(EXTENSIONS)
    .map((name) => join(EXTENSIONS, name))
    .filter((path) => statSync(path).isDirectory());

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    return path.endsWith(".ts") ? [path] : [];
  });

const importsOf = (file: string) =>
  [
    ...readFileSync(file, "utf8").matchAll(
      /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
    ),
  ].map((match) => match[1] ?? match[2]);

const isPiPackage = (specifier: string) =>
  specifier.startsWith("@earendil-works/") || specifier === "typebox";

const offendersIn = (dir: string, keep: (file: string) => boolean, bad: (specifier: string) => boolean) =>
  sourceFiles(dir)
    .filter(keep)
    .flatMap((file) =>
      importsOf(file)
        .filter(bad)
        .map((specifier) => `${relative(EXTENSIONS, file)} imports ${specifier}`),
    );

const isUnder = (root: string, segment: string) => (file: string) =>
  relative(root, file).startsWith(`${segment}${sep}`);

const exists = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

describe("architecture", () => {
  it("only src/adapter of an extension imports pi packages", () => {
    const offenders = extensionDirs().flatMap((extension) => {
      const src = join(extension, "src");

      return offendersIn(src, (file) => !isUnder(src, "adapter")(file), isPiPackage);
    });

    expect(offenders).toEqual([]);
  });

  it("plugins never import another plugin's code", () => {
    const offenders = extensionDirs()
      .map((extension) => join(extension, "src", "plugins"))
      .filter(exists)
      .flatMap((plugins) =>
        sourceFiles(plugins).flatMap((file) => {
          const own = relative(plugins, file).split(sep)[0];

          return importsOf(file)
            .filter((specifier) => specifier.startsWith("."))
            .filter((specifier) => {
              const target = relative(plugins, join(dirname(file), specifier));

              return !target.startsWith("..") && target.split(sep)[0] !== own;
            })
            .map((specifier) => `${relative(EXTENSIONS, file)} imports ${specifier}`);
        }),
      );

    expect(offenders).toEqual([]);
  });

  it("everything outside the adapter depends only on the adapter contract", () => {
    const offenders = extensionDirs().flatMap((extension) => {
      const src = join(extension, "src");

      return offendersIn(
        src,
        (file) => !isUnder(src, "adapter")(file) && relative(src, file) !== "index.ts",
        (specifier) => specifier.includes("adapter/") && !specifier.endsWith("adapter/contract.ts"),
      );
    });

    expect(offenders).toEqual([]);
  });

  it("extensions never import each other", () => {
    const offenders = extensionDirs().flatMap((extension) =>
      sourceFiles(extension).flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.startsWith("."))
          .filter((specifier) => relative(extension, join(dirname(file), specifier)).startsWith(".."))
          .map((specifier) => `${relative(EXTENSIONS, file)} imports ${specifier}`),
      ),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps every test outside src", () => {
    const offenders = extensionDirs().flatMap((extension) =>
      sourceFiles(join(extension, "src")).filter((file) => file.endsWith(".test.ts")),
    );

    expect(offenders).toEqual([]);
  });

  it("only the adapter tests import pi packages", () => {
    const offenders = extensionDirs().flatMap((extension) => {
      const test = join(extension, "test");

      return offendersIn(test, (file) => !isUnder(test, "adapter")(file), isPiPackage);
    });

    expect(offenders).toEqual([]);
  });
});
