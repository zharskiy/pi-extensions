import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

export const writeHandoffFile = (path: string, text: string) => {
  try {
    write(path, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    write(path, text);
  }
};
