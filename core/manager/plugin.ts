import type { AgentRuntime, Host } from "../../pi-adapter/index.ts";
import type { Bus, EventMap } from "./bus.ts";

export type Services<S> = {
  provide<K extends keyof S>(key: K, value: S[K]): void;
  require<K extends keyof S>(key: K): S[K];
  has(key: keyof S): boolean;
};

type PluginContext<E extends EventMap, S, C> = {
  host: Host;
  runtime: AgentRuntime;
  bus: Bus<E>;
  settings: C;
  services: Services<S>;
  root: string;
};

export type Disable = () => void | Promise<void>;

export type Plugin<E extends EventMap, S, C> = {
  id: string;
  requires?: string[];
  enable(ctx: PluginContext<E, S, C>): Disable | undefined;
};
