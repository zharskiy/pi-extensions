import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { MountSpec } from "../backend/index.ts";
import { visibleInside } from "../container/index.ts";
import { realOrResolved } from "../shared/index.ts";
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
