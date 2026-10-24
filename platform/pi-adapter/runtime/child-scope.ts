import { AsyncLocalStorage } from "node:async_hooks";
import { globalRecord } from "./global-record.ts";

type ChildScope = AsyncLocalStorage<{ agentId: string }>;

export const childScope = globalRecord<ChildScope>(
  "child-scope",
  () => new AsyncLocalStorage<{ agentId: string }>(),
);

export const insideChildSession = () => childScope.getStore() !== undefined;
