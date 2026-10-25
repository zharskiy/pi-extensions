import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SkillInfo } from "../types/messages.ts";

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

export type ParentSource = {
  ctx(): ExtensionContext;
  settings(): Settings;
  thinking(): string;
  inventorySkillFiles(): SkillInfo[];
  sessionSkillFiles(): SkillInfo[];
  activeTools(): { name: string; path: string }[];
  mcpDisabled(): boolean;
};

export const createChildExtension =
  (recordEntry: string): ExtensionFactory =>
  (pi) => {
    let recorded = false;

    pi.on("session_before_compact", () => ({ cancel: true }));

    pi.on("before_provider_request", (event) => {
      if (recorded) {
        return;
      }

      recorded = true;

      pi.appendEntry(recordEntry, { providerPayload: event.payload });
    });
  };
