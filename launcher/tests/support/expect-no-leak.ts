import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { type createFakeBackend, stdinOf } from "./fake-backend.ts";

type FakeBackend = Pick<ReturnType<typeof createFakeBackend>, "containers" | "execs">;

interface Surface {
  where: string;
  text: string;
}

const renderFiles = async (renderDir: string): Promise<Surface[]> => {
  const names = await readdir(renderDir, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = names.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  const texts = await Promise.all(files.map((path) => readFile(path, "utf8")));

  return files.map((path, index) => ({ where: `render file ${path}`, text: texts[index] ?? "" }));
};

const backendSurfaces = (fake: FakeBackend): Surface[] => [
  ...[...fake.containers.values()].map((entry) => ({
    where: `container spec ${entry.summary.name}`,
    text: JSON.stringify(entry.spec ?? entry.summary),
  })),
  ...fake.execs.flatMap((exec, index) => [
    { where: `exec ${index} argv`, text: JSON.stringify(exec.spec.command) },
    { where: `exec ${index} env`, text: JSON.stringify(exec.spec.env) },
    { where: `exec ${index} stdin`, text: stdinOf(exec).toString("utf8") },
  ]),
];

export const expectNoLeak = async (fake: FakeBackend, renderDir: string, secrets: string[]) => {
  const surfaces = [...backendSurfaces(fake), ...(await renderFiles(renderDir))];
  const leaks = surfaces.flatMap((surface) =>
    secrets
      .filter((secret) => secret !== "" && surface.text.includes(secret))
      .map((secret) => `${surface.where} holds ${secret}`),
  );

  expect(leaks).toEqual([]);
};
