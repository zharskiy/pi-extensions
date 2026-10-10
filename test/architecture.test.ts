import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const TEST = import.meta.dirname;

const SRC = join(TEST, "..", "src");

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

describe("architecture", () => {
  it("only src/adapter imports pi packages", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !relative(SRC, file).startsWith(`adapter${sep}`))
      .flatMap((file) =>
        importsOf(file)
          .filter(isPiPackage)
          .map((specifier) => `${relative(SRC, file)} imports ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it("plugins never import another plugin's code", () => {
    const offenders = sourceFiles(join(SRC, "plugins")).flatMap((file) => {
      const own = relative(join(SRC, "plugins"), file).split(sep)[0];

      return importsOf(file)
        .filter((specifier) => specifier.startsWith("../") && !specifier.startsWith("../../"))
        .filter((specifier) => !specifier.startsWith(`../${own}/`))
        .map((specifier) => `${relative(SRC, file)} imports ${specifier}`);
    });

    expect(offenders).toEqual([]);
  });

  it("components and the manager depend only on the adapter contract", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !relative(SRC, file).startsWith(`adapter${sep}`))
      .filter((file) => relative(SRC, file) !== "index.ts")
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.includes("adapter/") && !specifier.endsWith("adapter/contract.ts"))
          .map((specifier) => `${relative(SRC, file)} imports ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps every test outside src", () => {
    expect(sourceFiles(SRC).filter((file) => file.endsWith(".test.ts"))).toEqual([]);
  });

  it("only the adapter tests import pi packages", () => {
    const offenders = sourceFiles(TEST)
      .filter((file) => !relative(TEST, file).startsWith(`adapter${sep}`))
      .flatMap((file) =>
        importsOf(file)
          .filter(isPiPackage)
          .map((specifier) => `${relative(TEST, file)} imports ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });
});
