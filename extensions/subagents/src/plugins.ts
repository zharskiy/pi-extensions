import type { Plugin } from "./model/plugin.ts";
import { agentDefinitionsPlugin } from "./plugins/agent-definitions/index.ts";
import { agentPanelPlugin } from "./plugins/agent-panel/index.ts";
import { agentRegistryPlugin } from "./plugins/agent-registry/index.ts";
import { agentSetupPlugin } from "./plugins/agent-setup/index.ts";
import { agentStatusPlugin } from "./plugins/agent-status/index.ts";
import { agentViewPlugin } from "./plugins/agent-view/index.ts";
import { fetchToolPlugin } from "./plugins/fetch-tool/index.ts";
import { limitsPlugin } from "./plugins/limits/index.ts";
import { runAgentPlugin } from "./plugins/run-agent/index.ts";
import { usageReportPlugin } from "./plugins/usage-report/index.ts";

export const plugins: Plugin[] = [
  agentRegistryPlugin,
  agentDefinitionsPlugin,
  runAgentPlugin,
  usageReportPlugin,
  agentStatusPlugin,
  limitsPlugin,
  agentPanelPlugin,
  agentSetupPlugin,
  agentViewPlugin,
  fetchToolPlugin,
];
