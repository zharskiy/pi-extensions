import type { AgentRuntime, Host } from "../adapter/contract.ts";
import type { Bus } from "./bus.ts";
import type { Settings } from "./settings.ts";
import type { ServiceMap } from "./types.ts";

export type Services = {
  provide<K extends keyof ServiceMap>(key: K, value: ServiceMap[K]): void;
  require<K extends keyof ServiceMap>(key: K): ServiceMap[K];
  has(key: keyof ServiceMap): boolean;
};

export type PluginContext = {
  host: Host;
  runtime: AgentRuntime;
  bus: Bus;
  settings: Settings;
  services: Services;
  packageRoot: string;
};

export type Disable = () => void | Promise<void>;

export type Plugin = {
  id: string;
  requires?: string[];
  enable(ctx: PluginContext): Disable | undefined;
};
