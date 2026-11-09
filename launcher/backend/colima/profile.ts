import { join } from "node:path";
import type { Detection } from "../types.ts";

export interface Colima {
  home: string;
  profile: string;
  run(failure: string, args: string[], hint: string): Promise<void>;
  detectAgain(): Promise<Detection | undefined>;
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

export const ENGINE_PROFILE = "pi-sandbox";

export const VM_HOST_ALIAS = "host.lima.internal";

export const ENGINE_SOCKET_DISPLAY = `~/.colima/${ENGINE_PROFILE}/docker.sock`;

export const engineSocketPath = (home: string) => join(home, ".colima", ENGINE_PROFILE, "docker.sock");

export const instanceOf = (profile: string) => `colima-${profile}`;

export const plainStart = (profile: string) => `colima start --profile ${profile} --activate=false`;

export const logHint = (profile: string) => `~/.colima/_lima/${instanceOf(profile)}/ha.stderr.log`;
