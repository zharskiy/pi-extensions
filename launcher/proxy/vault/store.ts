import {
  loadVaultStore,
  readVaultStore,
  stateLayout,
  type VaultEntry,
  type VaultServer,
  withDirectoryLock,
  writeFileAtomic,
} from "../../shared/index.ts";

const PRIVATE_MODE = 0o600;

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

  return withDirectoryLock(layout.mcpAuthStoreLock, async () => {
    const store = await loadVaultStore(layout.mcpAuthStore, { forWrite: true });
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
