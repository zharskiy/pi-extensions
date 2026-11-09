import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { stateLayout, writeFileAtomic } from "../shared/index.ts";
import { readHostEntries, type Tree } from "./tree.ts";
import type { RenderInput, RenderResult } from "./types.ts";

const RENDER_COPIED_ENTRIES = [
  "agents",
  "prompts",
  "skills",
  "themes",
  "extensions",
  "AGENTS.md",
  "SYSTEM.md",
  "keybindings.json",
] as const;

const FILE_MODE = 0o644;

interface Existing {
  relative: string;
  directory: boolean;
}

const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const MAVEN_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <proxies>
    <proxy>
      <id>pi-sandbox</id>
      <active>true</active>
      <protocol>http</protocol>
      <host>\${env.PI_SANDBOX_PROXY_HOST}</host>
      <port>\${env.PI_SANDBOX_PROXY_PORT}</port>
      <username>pi-sandbox</username>
      <password>\${env.PI_SANDBOX_PROXY_TOKEN}</password>
    </proxy>
  </proxies>
</settings>
`;

const toolFiles = (): Array<[string, Buffer]> => [["tools/m2-settings.xml", Buffer.from(MAVEN_SETTINGS)]];

const desiredTree = async (input: RenderInput): Promise<Tree> => {
  const copied = await readHostEntries(input.hostAgentDir, RENDER_COPIED_ENTRIES);
  const files = input.derived.files;
  const rendered: Array<[string, unknown]> = [
    ["auth.json", files["auth.json"]],
    ["models.json", files["models.json"]],
    ["mcp.json", files["mcp.json"]],
  ];

  return new Map([
    ...rendered.map(([name, value]): [string, { data: Buffer; mode: number }] => [
      name,
      { data: jsonBytes(value), mode: FILE_MODE },
    ]),
    ...toolFiles().map(([name, data]): [string, { data: Buffer; mode: number }] => [
      name,
      { data, mode: FILE_MODE },
    ]),
    ...copied,
  ]);
};

const listExisting = async (dir: string, relative: string): Promise<Existing[]> => {
  const names = await readdir(join(dir, relative)).catch(() => []);
  const nested = await Promise.all(
    names.map(async (name) => {
      const path = posix.join(relative, name);
      const info = await lstat(join(dir, path));

      return info.isDirectory() && !info.isSymbolicLink()
        ? [{ relative: path, directory: true }, ...(await listExisting(dir, path))]
        : [{ relative: path, directory: false }];
    }),
  );

  return nested.flat();
};

const ancestorsOf = (path: string): string[] => {
  const parent = posix.dirname(path);

  return parent === "." ? [] : [parent, ...ancestorsOf(parent)];
};

const removeStale = async (dir: string, tree: Tree) => {
  const directories = new Set([...tree.keys()].flatMap(ancestorsOf));
  const existing = await listExisting(dir, "");
  const stale = existing.filter((entry) =>
    entry.directory ? !directories.has(entry.relative) : !tree.has(entry.relative),
  );

  await Promise.all(stale.map((entry) => rm(join(dir, entry.relative), { recursive: true, force: true })));
};

const isCurrent = async (path: string, data: Buffer, mode: number) => {
  const info = await lstat(path).catch(() => undefined);

  if (info === undefined || !info.isFile() || (info.mode & 0o777) !== mode || info.size !== data.length) {
    return false;
  }

  return (await readFile(path)).equals(data);
};

const writeChanged = async (dir: string, tree: Tree) => {
  await Promise.all(
    [...tree].map(async ([relative, file]) => {
      const path = join(dir, relative);

      if (!(await isCurrent(path, file.data, file.mode))) {
        await writeFileAtomic(path, file.data, { mode: file.mode });
      }
    }),
  );
};

export const renderAgentDir = async (input: RenderInput): Promise<RenderResult> => {
  const renderDir = stateLayout(input.stateDir).repo(input.repoHash).render;
  const tree = await desiredTree(input);

  await mkdir(renderDir, { recursive: true });

  await removeStale(renderDir, tree);

  await writeChanged(renderDir, tree);

  return { renderDir };
};
