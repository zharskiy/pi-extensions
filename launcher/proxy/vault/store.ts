import {
  mcpAuthKey,
  readVaultStore,
  updateVaultStore,
  type VaultEntry,
  type VaultServer,
} from "../../shared/index.ts";

export const serverUrlOf = (url: string) => String(new URL(url));

export const readStoreEntry = async (stateDir: string, server: Pick<VaultServer, "server" | "url">) =>
  (await readVaultStore(stateDir))[mcpAuthKey(server.server, server.url)];

export const updateStoreEntry = (
  stateDir: string,
  key: string,
  update: (current: VaultEntry | undefined) => VaultEntry | undefined,
): Promise<void> =>
  updateVaultStore(stateDir, (store) => {
    const next = update(store[key]);

    return next === undefined ? undefined : { ...store, [key]: next };
  });
