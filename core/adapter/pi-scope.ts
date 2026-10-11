import { AsyncLocalStorage } from "node:async_hooks";

type ChildScope = AsyncLocalStorage<{ agentId: string }>;

const SCOPE_KEY = Symbol.for("pi-extensions.child-scope");

const shared = globalThis as typeof globalThis & { [SCOPE_KEY]?: ChildScope };

shared[SCOPE_KEY] ??= new AsyncLocalStorage<{ agentId: string }>();

export const childScope: ChildScope = shared[SCOPE_KEY];

export const insideChildSession = () => childScope.getStore() !== undefined;
