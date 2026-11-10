import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { DerivedTools, GlabHost, ToolHost } from "../hostpi/index.ts";
import {
  escapeXml,
  type IniSection,
  type MavenHeader,
  type MavenRepository,
  type MavenServer,
  type NpmrcEntry,
  stateLayout,
  withFileLock,
  writeFileAtomic,
  xmlLines,
} from "../shared/index.ts";
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

const LOCK_TIMEOUT_MS = 30_000;

const IN_FLIGHT = /\.(\d+)\.[0-9a-f]{8}\.tmp$/;

const FRESH_TEMPORARY_MS = 60_000;

interface Existing {
  relative: string;
  directory: boolean;
}

const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const xmlElement = (indent: string, name: string, value: string | undefined) =>
  value === undefined ? [] : [`${indent}<${name}>${escapeXml(value)}</${name}>`];

const httpHeaders = (headers: MavenHeader[]) =>
  headers.length === 0
    ? []
    : [
        "        <httpHeaders>",
        ...headers.flatMap((header) => [
          "          <property>",
          ...xmlElement("            ", "name", header.name),
          ...xmlElement("            ", "value", header.value),
          "          </property>",
        ]),
        "        </httpHeaders>",
      ];

const serverConfiguration = (server: MavenServer) => {
  const lines = [
    ...(server.configuration ?? []).flatMap((element) => xmlLines(element, "        ")),
    ...httpHeaders(server.headers ?? []),
  ];

  return lines.length === 0 ? [] : ["      <configuration>", ...lines, "      </configuration>"];
};

const mavenServer = (server: MavenServer) => [
  "    <server>",
  ...xmlElement("      ", "id", server.id),
  ...xmlElement("      ", "username", server.username),
  ...xmlElement("      ", "password", server.password),
  ...serverConfiguration(server),
  "    </server>",
];

const mavenMirror = (mirror: MavenRepository) => [
  "    <mirror>",
  ...xmlElement("      ", "id", mirror.id),
  ...xmlElement("      ", "mirrorOf", mirror.mirrorOf),
  ...xmlElement("      ", "url", mirror.url),
  "    </mirror>",
];

const xmlList = (name: string, items: string[][]) =>
  items.length === 0 ? [] : [`  <${name}>`, ...items.flat(), `  </${name}>`];

const mavenSettings = (maven: DerivedTools["maven"]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">',
    "  <proxies>",
    "    <proxy>",
    "      <id>pi-sandbox</id>",
    "      <active>true</active>",
    "      <protocol>http</protocol>",
    `      <host>\${env.PI_SANDBOX_PROXY_HOST}</host>`,
    `      <port>\${env.PI_SANDBOX_PROXY_PORT}</port>`,
    "      <username>pi-sandbox</username>",
    `      <password>\${env.PI_SANDBOX_PROXY_TOKEN}</password>`,
    "    </proxy>",
    "  </proxies>",
    ...xmlList("servers", maven.servers.map(mavenServer)),
    ...xmlList("mirrors", maven.mirrors.map(mavenMirror)),
    ...maven.passthrough.flatMap((element) => xmlLines(element, "  ")),
    "</settings>",
    "",
  ].join("\n");

const yaml = (text: string) => JSON.stringify(text);

const ghHosts = (hosts: ToolHost[]) =>
  hosts.flatMap((entry) => [
    `${entry.host}:`,
    `    oauth_token: ${yaml(entry.token)}`,
    `    git_protocol: "https"`,
  ]);

const glabField = (name: string, value: string | undefined) =>
  value === undefined ? [] : [`        ${name}: ${yaml(value)}`];

const glabConfig = (hosts: GlabHost[]) => [
  'check_update: "false"',
  'telemetry: "false"',
  "hosts:",
  ...hosts.flatMap((entry) => [
    `    ${entry.host}:`,
    ...glabField("token", entry.token),
    ...glabField("user", entry.user),
    ...glabField("api_host", entry.apiHost),
    ...glabField("api_protocol", entry.apiProtocol),
    ...glabField("git_protocol", "https"),
    ...glabField("use_keyring", "false"),
  ]),
];

const gitValue = (text: string) =>
  `"${text
    .replace(/[\r\n]+/g, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;

const gitIdentity = (git: DerivedTools["git"]) => {
  const entries = (["name", "email"] as const).flatMap((key) => {
    const value = git[key];

    return value === undefined || value === "" ? [] : [`\t${key} = ${gitValue(value)}`];
  });

  return entries.length === 0 ? [] : ["[user]", ...entries];
};

const gitHost = (host: string, helper: string) => [
  `[credential "https://${host}"]`,
  '\thelper = ""',
  `\thelper = ${gitValue(helper)}`,
  `[url "https://${host}/"]`,
  `\tinsteadOf = ${gitValue(`git@${host}:`)}`,
  `\tinsteadOf = ${gitValue(`ssh://git@${host}/`)}`,
];

const gitConfig = (tools: DerivedTools) => [
  ...gitIdentity(tools.git),
  ...tools.gh.flatMap((entry) => gitHost(entry.host, "!gh auth git-credential")),
  ...tools.glab.flatMap((entry) => gitHost(entry.host, "!glab auth git-credential")),
];

const npmrc = (entries: NpmrcEntry[]) => entries.map((entry) => `${entry.key}=${entry.value}`);

const iniEntry = ([name, value]: [string, string]) =>
  value.includes("\n")
    ? [`${name} =`, ...value.split("\n").map((line) => `    ${line}`)]
    : [`${name} = ${value}`];

const pipConfig = (sections: IniSection[]) =>
  sections.flatMap((section) => [`[${section.name}]`, ...section.entries.flatMap(iniEntry)]);

const lines = (items: string[]) => Buffer.from(`${items.join("\n")}\n`);

const optional = (name: string, items: string[]): Array<[string, Buffer]> =>
  items.length === 0 ? [] : [[name, lines(items)]];

const toolFiles = (tools: DerivedTools): Array<[string, Buffer]> => [
  ["tools/m2-settings.xml", Buffer.from(mavenSettings(tools.maven))],
  ...optional("tools/gh-hosts.yml", ghHosts(tools.gh)),
  ...(tools.glab.length === 0 ? [] : optional("tools/glab-config.yml", glabConfig(tools.glab))),
  ...optional("tools/gitconfig", gitConfig(tools)),
  ...optional("tools/npmrc", npmrc(tools.npmrc ?? [])),
  ...optional("tools/pip.conf", pipConfig(tools.pip ?? [])),
];

const desiredTree = async (input: RenderInput): Promise<{ tree: Tree; notices: string[] }> => {
  const copied = await readHostEntries(input.hostAgentDir, RENDER_COPIED_ENTRIES);
  const files = input.derived.files;
  const rendered: Array<[string, unknown]> = [
    ["auth.json", files["auth.json"]],
    ["models.json", files["models.json"]],
    ["mcp.json", files["mcp.json"]],
  ];

  const tree: Tree = new Map([
    ...rendered.map(([name, value]): [string, { data: Buffer; mode: number }] => [
      name,
      { data: jsonBytes(value), mode: FILE_MODE },
    ]),
    ...toolFiles(input.derived.tools).map(([name, data]): [string, { data: Buffer; mode: number }] => [
      name,
      { data, mode: FILE_MODE },
    ]),
    ...copied.tree,
  ]);

  return { tree, notices: copied.notices };
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

const isLive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isInFlight = async (dir: string, relative: string, now: number) => {
  const pid = IN_FLIGHT.exec(relative)?.[1];

  if (pid === undefined) {
    return false;
  }

  const info = await lstat(join(dir, relative)).catch(() => undefined);

  return info !== undefined && (now - info.mtimeMs < FRESH_TEMPORARY_MS || isLive(Number(pid)));
};

const removeStale = async (dir: string, tree: Tree) => {
  const directories = new Set([...tree.keys()].flatMap(ancestorsOf));
  const existing = await listExisting(dir, "");
  const now = Date.now();
  const kept = await Promise.all(
    existing.map((entry) =>
      entry.directory || tree.has(entry.relative) ? false : isInFlight(dir, entry.relative, now),
    ),
  );
  const stale = existing.filter((entry, index) =>
    entry.directory ? !directories.has(entry.relative) : !tree.has(entry.relative) && kept[index] !== true,
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

export const renderAgentDir = async (input: RenderInput): Promise<RenderResult & { notices: string[] }> => {
  const renderDir = stateLayout(input.stateDir).repo(input.repoHash).render;
  const { tree, notices } = await desiredTree(input);

  await mkdir(renderDir, { recursive: true });

  await withFileLock(
    join(dirname(renderDir), "render.lock"),
    async () => {
      await removeStale(renderDir, tree);

      await writeChanged(renderDir, tree);
    },
    { timeoutMs: LOCK_TIMEOUT_MS },
  );

  return { renderDir, notices };
};
