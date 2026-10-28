import type { AgentRuntime, Host } from "../../pi-adapter/index.ts";

export type EventMap = Record<string, unknown>;

type Listener<E extends EventMap, K extends keyof E> = (payload: E[K]) => void;

export type Bus<E extends EventMap> = {
  on<K extends keyof E>(event: K, listener: Listener<E, K>): () => void;
  emit<K extends keyof E>(event: K, payload: E[K]): void;
};

export type Services<S> = {
  provide<K extends keyof S>(key: K, value: S[K]): void;
  require<K extends keyof S>(key: K): S[K];
  has(key: keyof S): boolean;
};

export type ExtensionPaths = { root: string; agentDir: string };

type PluginContext<E extends EventMap, S, C> = {
  host: Host;
  runtime: AgentRuntime;
  bus: Bus<E>;
  settings: C;
  services: Services<S>;
  paths: ExtensionPaths;
};

export type Disable = () => void | Promise<void>;

export type Plugin<E extends EventMap, S, C> = {
  id: string;
  requires?: string[];
  enable(ctx: PluginContext<E, S, C>): Disable | undefined;
};
