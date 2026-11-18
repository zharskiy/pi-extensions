import type { MountSpec } from "../backend/index.ts";
import { isWithin } from "../shared/index.ts";

const deepestMount = (path: string, mounts: MountSpec[]) =>
  mounts
    .filter((mount) => isWithin(path, mount.target))
    .reduce<MountSpec | undefined>(
      (deepest, mount) =>
        deepest === undefined || mount.target.length > deepest.target.length ? mount : deepest,
      undefined,
    );

export const visibleInside = (path: string, mounts: MountSpec[]) => {
  const mount = deepestMount(path, mounts);

  return mount?.kind === "bind" && mount.source === mount.target;
};
