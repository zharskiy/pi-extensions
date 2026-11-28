import { access, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { MountSpec } from "../backend/index.ts";
import { visibleInside } from "../container/index.ts";
import { isWithin, lstatOrUndefined, realOrResolved } from "../shared/index.ts";
import type { SandboxProxy } from "./sandbox-proxy.ts";

export const proxyDetail = (proxy: SandboxProxy) => `pid ${proxy.proxy.pid} port ${proxy.proxy.port}`;

const PATH_FLAGS = new Set(["--system-prompt", "--append-system-prompt", "--extension", "-e", "--session"]);

const pathArgs = (args: string[]) =>
  args.flatMap((arg, index) => {
    const value = args[index + 1];

    if (PATH_FLAGS.has(arg) && value !== undefined) {
      return [{ shown: `${arg} ${value}`, path: value }];
    }

    return arg.startsWith("@") && !PATH_FLAGS.has(args[index - 1] ?? "")
      ? [{ shown: arg, path: arg.slice(1) }]
      : [];
  });

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export const hostPathNotices = async (args: string[], cwd: string, mounts: MountSpec[]) => {
  const checked = await Promise.all(
    pathArgs(args).map(async ({ shown, path }) => {
      const absolute = resolve(cwd, path);

      return (await exists(absolute)) && !visibleInside(await realOrResolved(absolute), mounts)
        ? [
            `${shown}: ${absolute} lies outside the folders mounted in the sandbox, so pi inside cannot read it`,
          ]
        : [];
    }),
  );

  return checked.flat();
};

const foldersUpTo = (dir: string, top: string): string[] =>
  dir === top || !isWithin(dir, top) ? [dir] : [dir, ...foldersUpTo(dirname(dir), top)];

const danglingLink = async (path: string, mounts: MountSpec[]) => {
  const info = await lstatOrUndefined(path);
  const target = info?.isSymbolicLink() ? await realpath(path).catch(() => undefined) : undefined;

  return target === undefined || visibleInside(target, mounts) ? [] : [{ path, target }];
};

const danglingSkillLinks = async (dir: string, mounts: MountSpec[]) => {
  const own = await danglingLink(dir, mounts);
  const names = own.length === 0 ? await readdir(dir).catch(() => []) : [];
  const entries = await Promise.all(names.map((name) => danglingLink(join(dir, name), mounts)));

  return [...own, ...entries.flat()];
};

export const projectSkillLinkNotices = async (cwd: string, top: string, mounts: MountSpec[]) => {
  const dirs = [
    join(cwd, ".pi", "skills"),
    ...foldersUpTo(cwd, top).map((dir) => join(dir, ".agents", "skills")),
  ];
  const links = (await Promise.all(dirs.map((dir) => danglingSkillLinks(dir, mounts)))).flat();

  return links.length === 0
    ? []
    : [
        `project skills: links that dangle in the sandbox, because their targets lie outside the folders it mounts: ${links.map((link) => `${relative(cwd, link.path)} -> ${link.target}`).join(", ")}; move each target inside the workspace root, or bind its folder read-only at the same absolute path with mounts.binds in the user config`,
      ];
};
