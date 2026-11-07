import { readFile } from "node:fs/promises";
import {
  readVaultStore,
  stateLayout,
  type VaultEntry,
  type VaultServer,
  type VaultStore,
  withFileLock,
  writeFileAtomic,
} from "../../shared/index.ts";

const PRIVATE_MODE = 0o600;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStore = (text: string | undefined): VaultStore => {
  try {
    const parsed: unknown = text === undefined || text.trim() === "" ? {} : JSON.parse(text);

    return isObject(parsed)
      ? (Object.fromEntries(Object.entries(parsed).filter(([, entry]) => isObject(entry))) as VaultStore)
      : {};
  } catch {
    return {};
  }
};

export const vaultKey = (server: string, url: string) =>
  `mcp__${server.replaceAll("-", "_")}|${new URL(url).href}`;

export const serverUrlOf = (url: string) => String(new URL(url));

export const readStoreEntry = async (stateDir: string, server: Pick<VaultServer, "server" | "url">) =>
  (await readVaultStore(stateDir))[vaultKey(server.server, server.url)];

export const updateStoreEntry = (
  stateDir: string,
  key: string,
  update: (current: VaultEntry | undefined) => VaultEntry | undefined,
): Promise<boolean> => {
  const layout = stateLayout(stateDir);

  return withFileLock(layout.mcpAuthStoreLock, async () => {
    const store = parseStore(await readFile(layout.mcpAuthStore, "utf8").catch(() => undefined));
    const next = update(store[key]);

    if (next === undefined) {
      return false;
    }

    await writeFileAtomic(layout.mcpAuthStore, `${JSON.stringify({ ...store, [key]: next }, null, 2)}\n`, {
      mode: PRIVATE_MODE,
    });

    return true;
  });
};
