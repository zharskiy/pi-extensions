import type { Plugin } from "../../manager/plugin.ts";
import { createRegistry } from "./registry.ts";

export const agentRegistryPlugin: Plugin = {
  id: "agent-registry",
  enable: ({ bus, services }) => {
    services.provide("registry", createRegistry({ bus }));

    return undefined;
  },
};
