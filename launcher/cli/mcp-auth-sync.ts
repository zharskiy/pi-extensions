import type { Backend } from "../backend/index.ts";
import { containerMcpAuth } from "../hostpi/index.ts";
import { syncContainerMcpAuth } from "../provision/index.ts";
import { errorMessage, type VaultServer } from "../shared/index.ts";
import { type CliDeps, writeLine, writeNotices } from "./deps.ts";
import type { LaunchContext } from "./launch.ts";

interface McpAuthSyncInput {
  backend: Backend;
  containerId: string;
  servers: VaultServer[];
}

export const syncSandboxMcpAuth = async (deps: CliDeps, context: LaunchContext, input: McpAuthSyncInput) => {
  try {
    const entries = await containerMcpAuth({ stateDir: context.stateDir, servers: input.servers });
    const { notices } = await syncContainerMcpAuth({
      backend: input.backend,
      containerId: input.containerId,
      stateDir: context.stateDir,
      repoHash: context.repoHash,
      entries,
    });

    writeNotices(deps, notices);
  } catch (error) {
    writeLine(deps.stderr, `pi-sandbox: warning: mcp-auth.json was not synced: ${errorMessage(error)}`);
  }
};
