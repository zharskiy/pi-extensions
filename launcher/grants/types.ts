export interface Grant {
  host: string;
  port: number;
  repoHash?: string;
  createdAt: number;
}

export interface GrantRequest {
  host: string;
  port: number;
  repoHash?: string;
}

export interface GrantMatch {
  host: string;
  port?: number;
  repoHash?: string;
}

export interface SessionEntry {
  sessionId: string;
  pid: number;
  repoHash: string;
  startedAt: number;
}

export interface EndSessionInput {
  repoHash: string;
  sessionId: string;
  onLast: () => Promise<void>;
}
