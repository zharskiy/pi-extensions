import type { Plugin } from "../core/model/plugin.ts";
import { agentDefinitionsPlugin } from "./plugins/agent-definitions.ts";
import { agentPanelPlugin } from "./plugins/agent-panel.ts";
import { agentRegistryPlugin } from "./plugins/agent-registry.ts";
import { agentSetupPlugin } from "./plugins/agent-setup.ts";
import { agentStatusPlugin } from "./plugins/agent-status.ts";
import { agentViewPlugin } from "./plugins/agent-view.ts";
import { fetchToolPlugin } from "./plugins/fetch-tool.ts";
import { interruptPlugin } from "./plugins/interrupt.ts";
import { limitsPlugin } from "./plugins/limits.ts";
import { runAgentPlugin } from "./plugins/run-agent.ts";
import { usageReportPlugin } from "./plugins/usage-report.ts";

export const plugins: Plugin[] = [
  agentRegistryPlugin,
  agentDefinitionsPlugin,
  runAgentPlugin,
  usageReportPlugin,
  agentStatusPlugin,
  limitsPlugin,
  agentPanelPlugin,
  interruptPlugin,
  agentSetupPlugin,
  agentViewPlugin,
  fetchToolPlugin,
];
