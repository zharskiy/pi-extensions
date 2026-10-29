import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel } from "../types/model.ts";
import { globalRecord } from "./global-record.ts";

const KEPT_SELECTION_TYPE = "pi-adapter:kept-selection";

type KeptSelection = { provider: string; id: string; thinking: string };

type SelectionApi = Pick<ExtensionAPI, "setModel" | "setThinkingLevel">;

const claimedSessions = () => globalRecord<Set<string>>("kept-selections", () => new Set());

export const keepSelection = (thinking: string, ctx: ExtensionContext) => {
  const model = ctx.model;

  if (!model) {
    return undefined;
  }

  const selection: KeptSelection = { provider: model.provider, id: model.id, thinking };

  return async (sessionManager: SessionManager) => {
    sessionManager.appendCustomEntry(KEPT_SELECTION_TYPE, selection);
  };
};

export const claimKeptSelection = (ctx: ExtensionContext) => {
  const entry = ctx.sessionManager
    .getEntries()
    .findLast((candidate) => candidate.type === "custom" && candidate.customType === KEPT_SELECTION_TYPE);
  const claimed = claimedSessions();
  const session = ctx.sessionManager.getSessionId();

  if (entry?.type !== "custom" || claimed.has(session)) {
    return undefined;
  }

  claimed.add(session);

  return entry.data as KeptSelection;
};

export const restoreSelection = async (pi: SelectionApi, ctx: ExtensionContext, kept: KeptSelection) => {
  const model = ctx.modelRegistry.find(kept.provider, kept.id);
  const restored = model !== undefined && (await pi.setModel(model).catch(() => false));

  if (!restored) {
    const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the default model";

    ctx.ui.notify(
      `Could not keep ${kept.provider}/${kept.id} after the handoff; the new session uses ${fallback}.`,
      "warning",
    );

    return;
  }

  if (isThinkingLevel(kept.thinking)) {
    pi.setThinkingLevel(kept.thinking);
  }
};
