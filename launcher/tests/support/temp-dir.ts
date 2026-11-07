import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

export const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), `pi-sandbox-${prefix}-`));

  created.push(dir);

  return dir;
};

export const writeText = async (path: string, text: string | Buffer) => {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, text);
};

export const writeJson = (path: string, value: unknown) => writeText(path, JSON.stringify(value, null, 2));
