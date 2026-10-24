import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AnyToolSpec } from "./contract.ts";

export type HostState = { ctx?: ExtensionContext; tools: Map<string, AnyToolSpec> };

export const tuiContext = (state: HostState) => (state.ctx?.mode === "tui" ? state.ctx : undefined);
