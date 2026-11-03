import { join } from "node:path";

export const proxyRoot = (stateDir: string) => join(stateDir, "proxy");

export const proxyFiles = (stateDir: string, policyHash: string) => {
  const directory = join(proxyRoot(stateDir), policyHash);

  return {
    directory,
    record: join(directory, "proxy.json"),
    config: join(directory, "proxy-config.json"),
    token: join(directory, "proxy-token"),
    accessLog: join(directory, "proxy-access.log"),
    proxyLog: join(directory, "proxy.log"),
    lock: join(directory, "lock"),
  };
};

export interface ProxyInstance {
  policyHash: string;
  port: number;
  token: string;
  pid: number;
}

export interface DaemonConfig<Config> {
  token: string;
  config: Config;
}
