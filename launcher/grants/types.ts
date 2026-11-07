export interface Grant {
  host: string;
  port: number;
  repoHash?: string;
  createdAt: number;
  expiresAt?: number;
  launchId?: string;
}

export type GrantScope =
  | { kind: "session"; launchId: string }
  | { kind: "hours"; hours: number }
  | { kind: "permanent" };

export interface GrantRequest {
  host: string;
  port: number;
  repoHash?: string;
  scope: GrantScope;
}

export interface GrantLimits {
  enabled: boolean;
  maxHours: number;
  permanent: boolean;
}

export interface GrantMatch {
  host: string;
  port?: number;
  repoHash?: string;
}

export interface ActiveGrantContext {
  now: number;
  repoHash: string;
  liveLaunches: ReadonlySet<string>;
}

export interface SessionEntry {
  launchId: string;
  pid: number;
  repoHash: string;
  startedAt: number;
}

export interface EndSessionInput {
  repoHash: string;
  launchId: string;
  onLast: () => Promise<void>;
}
