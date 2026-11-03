import { lstat } from "node:fs/promises";

export type RootState = "safe" | "missing" | "unsafe";

export const rootState = async (root: string): Promise<RootState> => {
  const stat = await lstat(root).catch(() => undefined);

  if (!stat) {
    return "missing";
  }

  const owned = !process.getuid || stat.uid === process.getuid();

  return stat.isDirectory() && owned && (stat.mode & 0o022) === 0 ? "safe" : "unsafe";
};
