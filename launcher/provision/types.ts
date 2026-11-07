import type { Backend } from "../backend/index.ts";
import type { SandboxConfig } from "../config/index.ts";
import type { DerivedSandboxPi, JsonObject, PackageChangeKind } from "../hostpi/index.ts";

export interface RenderInput {
  stateDir: string;
  repoHash: string;
  hostAgentDir: string;
  derived: DerivedSandboxPi;
}

export interface RenderResult {
  renderDir: string;
  entries: string[];
  hash: string;
}

export interface SyncInput {
  backend: Backend;
  containerId: string;
  stateDir: string;
  repoHash: string;
  hostAgentDir: string;
  repoRoot: string;
  config: SandboxConfig;
  hostSettings?: JsonObject;
  mcp: JsonObject;
}

export interface SyncResult {
  notices: string[];
}

export interface PackageDiff {
  kind: PackageChangeKind;
  entry?: unknown;
}
