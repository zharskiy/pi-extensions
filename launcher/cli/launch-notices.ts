import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { MountSpec } from "../backend/index.ts";
import { overlayVolumes, visibleInside } from "../container/index.ts";
import { realOrResolved } from "../shared/index.ts";
import { workspaceNotices } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";

const CAPPED_NOTICE = "more than 512 build output directories; overlays disabled, the host copies are used";

const TRUNCATED_NOTICE =
  "the folder is too large to search for build output; overlays disabled, the host copies are used";

const overlayNotices = (context: LaunchContext) => {
  if (context.workspace.overlaysCapped === true) {
    return [CAPPED_NOTICE];
  }

  if (context.workspace.overlaysTruncated === true) {
    return [TRUNCATED_NOTICE];
  }

  const paths = overlayVolumes(context.workspace, context.effective.config).map((overlay) => overlay.path);

  if (paths.length === 0) {
    return [];
  }

  const places = paths.length === 1 ? "1 directory" : `${paths.length} directories`;
  const kinds = [...new Set(paths.map((path) => basename(path)))].sort().join(", ");

  return [
    `${kinds} overlaid in ${places}; the host copies are hidden; set mounts.autoOverlays=false to keep them`,
  ];
};

export const launchNotices = (context: LaunchContext) => [
  ...workspaceNotices(context.workspace),
  ...overlayNotices(context),
];

export const proxyDetail = (proxy: { pid: number; port: number }) => `pid ${proxy.pid} port ${proxy.port}`;

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
