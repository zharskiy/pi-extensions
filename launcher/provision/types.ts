import type { Backend } from "../backend/index.ts";
import type { DerivedSandboxPi } from "../hostpi/index.ts";
import type { WriteBackTable } from "../shared/index.ts";

export interface RenderInput {
  stateDir: string;
  repoHash: string;
  hostAgentDir: string;
  hostHome: string;
  derived: DerivedSandboxPi;
  othersLive?: () => Promise<boolean>;
}

export interface RenderResult {
  renderDir: string;
}

export interface SyncInput {
  backend: Backend;
  containerId: string;
  stateDir: string;
  repoHash: string;
  hostAgentDir: string;
  repoRoot: string;
  allowlist: WriteBackTable;
  hostHome?: string;
  refreshPackages?: boolean;
  othersLive?: () => Promise<boolean>;
  readTimeoutMs?: number;
  removeTimeoutMs?: number;
}

export interface SyncResult {
  notices: string[];
  changes: string[];
}
