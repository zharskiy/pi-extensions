export interface Grant {
  host: string;
  port: number;
  repoHash?: string;
  createdAt: number;
}

export interface GrantMatch {
  host: string;
  port?: number;
  repoHash?: string;
}

export type GrantRequest = GrantMatch & { port: number };

export interface Launch {
  launchId: string;
  pid: number;
  boot: number;
  start: string;
  repoHash: string;
  startedAt: number;
}

export interface EndLaunchInput {
  repoHash: string;
  launchId: string;
  onLast: () => Promise<void>;
}
