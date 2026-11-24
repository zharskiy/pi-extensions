import { join } from "node:path";
import type { Detection, VmBusy, VmShare, VmTarget } from "../types.ts";
import { sizeFlags } from "./size.ts";

export interface Colima {
  home: string;
  profile: string;
  run(failure: string, args: string[], hint: string): Promise<void>;
  detectAgain(delaysMs?: number[]): Promise<Detection | undefined>;
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

export const ENGINE_PROFILE = "pi-sandbox";

export const VM_HOST_ALIAS = "host.lima.internal";

export const ENGINE_SOCKET_DISPLAY = `~/.colima/${ENGINE_PROFILE}/docker.sock`;

export const engineSocketPath = (home: string) => join(home, ".colima", ENGINE_PROFILE, "docker.sock");

export const instanceOf = (profile: string) => `colima-${profile}`;

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

const CREATE_FLAGS = ["--vm-type", "vz", "--mount-type", "virtiofs"];

const shellWord = (word: string) => (SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

export const shareText = (share: VmShare) => (share.writable ? `${share.location}:w` : share.location);

interface StartParts {
  shares?: VmShare[];
  size?: VmTarget;
  create?: boolean;
}

export const startArgs = (profile: string, parts: StartParts = {}) => [
  "start",
  "--profile",
  profile,
  "--activate=false",
  ...(parts.shares ?? []).flatMap((share) => ["--mount", shareText(share)]),
  ...(parts.create === true ? CREATE_FLAGS : []),
  ...sizeFlags(parts.size ?? {}),
];

export const plainStart = (profile: string, shares: VmShare[]) =>
  `colima ${startArgs(profile, { shares }).map(shellWord).join(" ")}`;

export const PI_STARTS_VM = "run pi, which starts the sandbox VM with its planned shares";

export const restartText = (profile: string, parts: StartParts = {}) =>
  `colima stop --profile ${profile} && colima ${startArgs(profile, parts).map(shellWord).join(" ")}`;

export const logHint = (profile: string) => `~/.colima/_lima/${instanceOf(profile)}/ha.stderr.log`;

export const sessionsRunning = (count: number) =>
  count === 1 ? "1 pi session is running" : `${count} pi sessions are running`;

const deferredUntilIdle = (change: string) =>
  `the sandbox VM will ${change} at the next launch with no other pi session running`;

const othersText = (others: string[]) =>
  others.length === 0
    ? ""
    : ` (${others.join(", ")} of another pinata install; remove a leftover with docker --context ${instanceOf(ENGINE_PROFILE)} rm --force <name>)`;

export const busyText = (busy: VmBusy) => `${sessionsRunning(busy.count)}${othersText(busy.others)}`;

export const deferredWhileBusy = (change: string, busy: VmBusy) =>
  busy.others.length === 0 ? deferredUntilIdle(change) : `${deferredUntilIdle(change)}: ${busyText(busy)}`;
