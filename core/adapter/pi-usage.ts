import { getLastAssistantUsage } from "@earendil-works/pi-coding-agent";
import type { Host, PromptTokens } from "./contract.ts";
import type { HostState } from "./pi-ui.ts";
import { requestUsageOf, sumAssistantUsage } from "./usage.ts";

type UsageCache = { session: string; file: string | undefined; leaf: string | null; usage: PromptTokens };

export const usageHost = (state: HostState): Pick<Host, "lastRequestUsage" | "mainRequestUsage"> => {
  let cache: UsageCache | undefined;

  return {
    lastRequestUsage: () => {
      const usage = state.ctx ? getLastAssistantUsage(state.ctx.sessionManager.getBranch()) : undefined;

      return usage ? requestUsageOf(usage) : undefined;
    },
    mainRequestUsage: () => {
      const manager = state.ctx?.sessionManager;

      if (!manager) {
        cache = undefined;

        return requestUsageOf(undefined);
      }

      const session = manager.getSessionId();
      const file = manager.getSessionFile();
      const leaf = manager.getLeafId();

      if (cache && cache.session === session && cache.file === file && cache.leaf === leaf) {
        return cache.usage;
      }

      cache = { session, file, leaf, usage: sumAssistantUsage(manager.getEntries()) };

      return cache.usage;
    },
  };
};
