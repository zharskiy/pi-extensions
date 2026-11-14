import type { VmInspect, VmShare, VmSpec } from "../../backend/index.ts";
import type { JsonObject } from "../../shared/index.ts";

export type Section = "folders" | "vm" | "writeBack";

export interface FolderCandidate {
  stored: string;
  resolved: string;
  exists: boolean;
  repos: number;
  capped: boolean;
  origin: "config" | "env" | "cwd" | "usual";
  here: boolean;
  latestRepo?: string;
}

export type VmFacts = VmInspect | { state: "unknown"; reason: string };

export interface HostFacts {
  home: string;
  cwd: string;
  cpus: number;
  memoryGiB: number;
  freeDiskGiB?: number;
  automatic: VmSpec;
  vm: VmFacts;
  sessions: number;
  candidates: FolderCandidate[];
  configFile: string;
  docsFile: string;
}

export interface ConfigDocument {
  file: string;
  text: string | undefined;
  value: JsonObject;
  indent: string;
  newline: boolean;
}

export type DocumentRead =
  | { ok: true; document: ConfigDocument }
  | { ok: false; kind: "json" | "config"; message: string };

export interface OwnedProblem {
  key: string;
  message: string;
}

export interface Answers {
  roots: string[] | "home";
  vm: "automatic" | VmSpec | { kept: Partial<VmSpec> };
  writeBack: boolean;
}

export interface Change {
  key: string;
  kind: "add" | "change" | "remove";
  before?: unknown;
  after?: unknown;
}

export type VmPart = "size" | "folders";

export type VmAction =
  | { kind: "none" }
  | { kind: "create"; size: VmSpec; shares: VmShare[] }
  | { kind: "restart"; size: VmSpec; shares: VmShare[]; exactShares: boolean; parts: VmPart[] }
  | { kind: "defer"; sessions: number; parts: VmPart[] }
  | { kind: "on-next-start"; parts: VmPart[] }
  | { kind: "unknown"; reason: string };

export type SharePlan = { shares: VmShare[]; exact: boolean } | { problem: string };

export interface Plan {
  next: JsonObject;
  text: string;
  changes: Change[];
  reindented: boolean;
  vm: VmAction;
  problems: string[];
}
