import { getLastAssistantUsage } from "@earendil-works/pi-coding-agent";
import type { PromptTokens } from "../types/context.ts";
import type { SessionHost } from "../types/host-capabilities.ts";
import type { HostState } from "../ui/tui-context.ts";
import { requestUsageOf, sumAssistantUsage } from "./usage-math.ts";

type UsageCache = { session: string; file: string | undefined; leaf: string | null; usage: PromptTokens };

export const usageHost = (state: HostState): Pick<SessionHost, "lastRequestUsage" | "mainRequestUsage"> => {
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
