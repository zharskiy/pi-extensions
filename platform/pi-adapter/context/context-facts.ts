import {
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ContextFacts } from "../types/context.ts";
import type { SessionHost } from "../types/host-capabilities.ts";
import type { HostState } from "../ui/tui-context.ts";
import { messageFacts } from "./context-messages.ts";
import { type PromptApi, promptFacts } from "./context-prompt.ts";
import { usageHost } from "./usage-events.ts";

type ContextApi = PromptApi & Pick<ExtensionAPI, "getSettings">;

type CompactionSettings = {
  enabled?: boolean;
  reserveTokens?: number;
  modelOverrides?: Record<string, { reserveTokens?: number } | undefined>;
};

const reserveOf = (pi: ContextApi, model: ExtensionContext["model"]) => {
  const compaction = (pi.getSettings() as { compaction?: CompactionSettings }).compaction;

  if ((compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled) === false) {
    return 0;
  }

  const override = model
    ? compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens
    : undefined;

  return override ?? compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
};

const factsOf = (pi: ContextApi, ctx: ExtensionContext): ContextFacts => {
  const messages = ctx.sessionManager.buildSessionProjection().messages;
  const usage = ctx.getContextUsage();

  return {
    model: ctx.model?.name ?? ctx.model?.id,
    window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
    total: usage?.tokens ?? null,
    reserve: reserveOf(pi, ctx.model),
    ...promptFacts(pi, messages, () => ctx.getSystemPrompt()),
    messages: messageFacts(messages),
  };
};

export const contextHost = (
  pi: ContextApi,
  state: HostState,
): Pick<SessionHost, "contextFacts" | "lastRequestUsage" | "mainRequestUsage"> => ({
  contextFacts: () => (state.ctx ? factsOf(pi, state.ctx) : undefined),
  ...usageHost(state),
});
