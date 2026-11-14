import type { Backend } from "../backend/index.ts";
import type { DerivedSandboxPi } from "../hostpi/index.ts";

export interface RenderInput {
  stateDir: string;
  repoHash: string;
  hostAgentDir: string;
  derived: DerivedSandboxPi;
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
  readTimeoutMs?: number;
}

export interface SyncResult {
  notices: string[];
  changes: string[];
}
