import type { Backend } from "../backend/index.ts";
import type { DerivedSandboxPi } from "../hostpi/index.ts";
import type { WriteBackTable } from "../shared/index.ts";

export interface SandboxStatusInput {
  resources: {
    cpus?: number;
    memoryGiB?: number;
    pids: number;
    openFiles?: number;
    shmMiB?: number;
  };
  volumes: string[];
  binds: string[];
  setup: string[][];
  services: Array<{ name: string; command: string[]; ready?: string[]; ports: number[] }>;
}

export interface RenderInput {
  stateDir: string;
  hostAgentDir: string;
  hostHome: string;
  derived: DerivedSandboxPi;
  status: SandboxStatusInput;
}

export interface RenderResult {
  renderDir: string;
}

export interface SyncInput {
  backend: Backend;
  containerId: string;
  stateDir: string;
  hostAgentDir: string;
  workspaceRoot: string;
  allowlist: WriteBackTable;
  hostHome?: string;
  refreshPackages?: boolean;
  othersLive?: () => Promise<boolean>;
  readTimeoutMs?: number;
  removeTimeoutMs?: number;
}

export interface PackageChanges {
  sources: string[];
  changed: string[];
}

export interface SyncResult {
  notices: string[];
  changes: string[];
  packages?: PackageChanges;
}
