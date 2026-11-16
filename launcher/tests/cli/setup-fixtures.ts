import type { VmShare, VmSpec } from "../../backend/index.ts";
import { readDocument } from "../../cli/setup/document.ts";
import type { ConfigDocument, FolderCandidate, HostFacts, VmFacts } from "../../cli/setup/types.ts";

export const HOME = "/Users/me";

export const AUTOMATIC_SIZE = { cpus: 8, memoryGiB: 10, diskGiB: 60 };

export const candidateOf = (overrides: Partial<FolderCandidate> = {}): FolderCandidate => ({
  stored: "~/x",
  resolved: `${HOME}/x`,
  exists: true,
  repos: 0,
  capped: false,
  origin: "usual",
  here: false,
  ...overrides,
});

export const factsOf = (overrides: Partial<HostFacts> = {}): HostFacts => ({
  home: HOME,
  cwd: HOME,
  cpus: 12,
  memoryGiB: 32,
  freeDiskGiB: 412,
  automatic: AUTOMATIC_SIZE,
  vm: { state: "absent" },
  sessions: 0,
  candidates: [],
  configFile: `${HOME}/.pi/agent/pi-sandbox/config.json`,
  docsFile: "/opt/launcher/CONFIGURATION.md",
  ...overrides,
});

export const runningVm = (size: VmSpec = AUTOMATIC_SIZE, shares: VmShare[] | "unreadable" = []): VmFacts => ({
  state: "running",
  size,
  shares,
});

export const documentOf = (text: string | undefined, file: string): ConfigDocument => {
  const read = readDocument(file, text);

  if (!read.ok) {
    throw new Error(read.message);
  }

  return read.document;
};
