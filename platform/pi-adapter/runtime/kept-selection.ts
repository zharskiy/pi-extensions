import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel } from "../types/model.ts";
import { globalRecord } from "./global-record.ts";

const KEPT_SELECTION_TYPE = "pi-adapter:kept-selection";

type KeptSelection = { provider: string; id: string; thinking: string };

type RestoredSelection = { model: string; thinking: string; applied: boolean };

type SelectionApi = Pick<ExtensionAPI, "setModel" | "setThinkingLevel" | "getThinkingLevel">;

const claimedSessions = () => globalRecord<Set<string>>("kept-selections", () => new Set());

const restoredSelections = () =>
  globalRecord<Map<string, RestoredSelection>>("restored-selections", () => new Map());

const sessionOf = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();

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
  const session = sessionOf(ctx);

  if (entry?.type !== "custom" || claimed.has(session)) {
    return undefined;
  }

  claimed.add(session);

  return entry.data as KeptSelection;
};

export const restoredSelection = (ctx: ExtensionContext) => restoredSelections().get(sessionOf(ctx));

export const releaseRestoredSelection = (ctx: ExtensionContext) => {
  restoredSelections().delete(sessionOf(ctx));
};

export const forgetSelection = (ctx: ExtensionContext) => {
  releaseRestoredSelection(ctx);
  claimedSessions().delete(sessionOf(ctx));
};

export const restoreSelection = async (pi: SelectionApi, ctx: ExtensionContext, kept: KeptSelection) => {
  const model = ctx.modelRegistry.find(kept.provider, kept.id);
  const ref = `${kept.provider}/${kept.id}`;

  restoredSelections().set(sessionOf(ctx), { model: ref, thinking: kept.thinking, applied: false });

  const restored = model !== undefined && (await pi.setModel(model).catch(() => false));

  if (!restored) {
    const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the default model";

    releaseRestoredSelection(ctx);
    ctx.ui.notify(`Could not keep ${ref} after the handoff; the new session uses ${fallback}.`, "warning");

    return;
  }

  if (isThinkingLevel(kept.thinking)) {
    pi.setThinkingLevel(kept.thinking);
  }

  restoredSelections().set(sessionOf(ctx), { model: ref, thinking: pi.getThinkingLevel(), applied: true });
};
