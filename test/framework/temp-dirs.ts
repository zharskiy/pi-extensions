import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

export const useTempDirs = () => {
  const created: string[] = [];

  afterAll(() => {
    created.splice(0).forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
  });

  const track = (path: string) => {
    created.push(path);
  };

  const make = (prefix = "pi-test-") => {
    const dir = mkdtempSync(join(tmpdir(), prefix));

    track(dir);

    return dir;
  };

  return { make, track };
};
