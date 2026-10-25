import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SkillFile } from "./skills.ts";

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

export type ParentSource = {
  ctx(): ExtensionContext;
  settings(): Settings;
  thinking(): string;
  inventorySkillFiles(): SkillFile[];
  sessionSkillFiles(): SkillFile[];
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
