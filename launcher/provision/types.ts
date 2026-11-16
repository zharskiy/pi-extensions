import type { Backend } from "../backend/index.ts";
import type { DerivedSandboxPi } from "../hostpi/index.ts";

export interface RenderInput {
  stateDir: string;
  repoHash: string;
  hostAgentDir: string;
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
  refreshPackages?: boolean;
  othersLive?: () => Promise<boolean>;
  readTimeoutMs?: number;
  removeTimeoutMs?: number;
}

export interface SyncResult {
  notices: string[];
  changes: string[];
}
