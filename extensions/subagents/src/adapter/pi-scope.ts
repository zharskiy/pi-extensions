import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const childScope = new AsyncLocalStorage<{ agentId: string }>();

export const insideChildSession = () => childScope.getStore() !== undefined;
