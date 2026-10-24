import { AsyncLocalStorage } from "node:async_hooks";
import { shared } from "./pi-shared.ts";

type ChildScope = AsyncLocalStorage<{ agentId: string }>;

export const childScope = shared<ChildScope>(
  "child-scope",
  () => new AsyncLocalStorage<{ agentId: string }>(),
);

export const insideChildSession = () => childScope.getStore() !== undefined;
