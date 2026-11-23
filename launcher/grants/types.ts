export interface Grant {
  host: string;
  port: number;
  createdAt: number;
}

export interface GrantRequest {
  host: string;
  port: number;
}

export interface GrantMatch {
  host: string;
  port?: number;
}

export interface Launch {
  launchId: string;
  pid: number;
  boot: number;
  start: string;
  repoHash: string;
  startedAt: number;
}
