export interface ProxyInstance {
  policyHash: string;
  port: number;
  token: string;
  pid: number;
  listenHosts?: string[];
}

export interface DaemonConfig<Config> {
  token: string;
  config: Config;
  egressCap?: { derivedHosts?: string[]; grants?: string[] };
  piCommand?: string[];
  discoverCommand?: string[];
  piVersion?: string;
  parentEnv?: Record<string, string>;
  listenHosts?: string[];
}
