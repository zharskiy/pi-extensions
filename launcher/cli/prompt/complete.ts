import { join } from "node:path";

export interface Completion {
  value: string;
  matches: string[];
}

const sharedPrefix = (left: string, right: string) => {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const length = leftChars.findIndex((char, index) => rightChars[index] !== char);

  return length < 0 ? left : leftChars.slice(0, length).join("");
};

const listing = (readdir: (dir: string) => string[], dir: string) => {
  try {
    return readdir(dir);
  } catch {
    return [];
  }
};

const readableDir = (typed: string, home: string) => {
  if (typed.startsWith("~/")) {
    return join(home, typed.slice(2), ".");
  }

  return typed.startsWith("/") ? join(typed, ".") : undefined;
};

export const completePath = (value: string, home: string, readdir: (dir: string) => string[]): Completion => {
  if (value === "~") {
    return { value: "~/", matches: [] };
  }

  const typedDir = value.slice(0, value.lastIndexOf("/") + 1);
  const segment = value.slice(typedDir.length);
  const dir = readableDir(typedDir, home);

  if (dir === undefined) {
    return { value, matches: [] };
  }

  const names = listing(readdir, dir)
    .filter((name) => name.startsWith(segment) && (segment.startsWith(".") || !name.startsWith(".")))
    .sort();

  if (names.length === 0) {
    return { value, matches: [] };
  }

  if (names.length === 1) {
    return { value: `${typedDir}${names[0]}/`, matches: [] };
  }

  const prefix = names.reduce(sharedPrefix);

  return { value: `${typedDir}${prefix}`, matches: names.map((name) => `${typedDir}${name}/`) };
};
