import type { VmApplied, VmInspect, VmPhase, VmShare, VmSpec } from "../../backend/index.ts";
import type { JsonObject } from "../../shared/index.ts";
import type { Prompts } from "../prompt/types.ts";

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
  searchTimedOut?: boolean;
}

export interface ConfigDocument {
  file: string;
  text: string | undefined;
  value: JsonObject;
  indent: string;
  newline: boolean;
  crlf?: boolean;
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

export type Outcome =
  | { kind: "apply"; plan: Plan; answers: Answers }
  | { kind: "unchanged" }
  | { kind: "cancelled" };

export interface SetupIo {
  prompts: Prompts;
  plain: boolean;
  now(): number;
}

export type RunningVm = Extract<VmAction, { kind: "create" | "restart" }>;

export type VmFailure = { kind: "vm-failed"; action: RunningVm; elapsed: string; reason: string };

export type ApplyEvent =
  | { kind: "nothing-to-do" }
  | { kind: "saved" }
  | { kind: "save-failed"; reason: string }
  | { kind: "nothing-changed" }
  | { kind: "vm-unknown"; reason: string }
  | { kind: "vm-stopped" }
  | { kind: "vm-deferred"; sessions: number; parts: VmPart[] }
  | { kind: "vm-done"; applied: VmApplied; action: RunningVm; elapsed: string }
  | VmFailure
  | { kind: "vm-not-ready" }
  | { kind: "vm-cancelled"; phase: VmPhase | undefined }
  | { kind: "done"; roots: Answers["roots"]; deferred: boolean };

interface VmTask {
  interruptWarning(): string;
  run(update: (text: string) => void): Promise<VmApplied>;
}

export interface ApplyFrontEnd {
  now(): number;
  review(): void;
  report(event: ApplyEvent): void;
  task(spec: VmTask): Promise<VmApplied>;
  retry(failure: VmFailure): Promise<boolean>;
}

export interface ApplyEffects {
  write(document: ConfigDocument, text: string): Promise<void>;
  vm(action: VmAction, progress: (phase: VmPhase) => void): Promise<VmApplied>;
}
