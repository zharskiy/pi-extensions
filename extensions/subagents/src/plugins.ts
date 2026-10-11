import type { Plugin } from "./manager/plugin.ts";
import { agentDefinitionsPlugin } from "./plugins/agent-definitions/index.ts";
import { agentListViewPlugin } from "./plugins/agent-list-view/index.ts";
import { agentRegistryPlugin } from "./plugins/agent-registry/index.ts";
import { agentStatusPlugin } from "./plugins/agent-status/index.ts";
import { agentViewPlugin } from "./plugins/agent-view/index.ts";
import { handoffPlugin } from "./plugins/handoff/index.ts";
import { limitsPlugin } from "./plugins/limits/index.ts";
import { progressWidgetPlugin } from "./plugins/progress-widget/index.ts";
import { runAgentPlugin } from "./plugins/run-agent/index.ts";
import { spendingPlugin } from "./plugins/spending/index.ts";

export const plugins: Plugin[] = [
  spendingPlugin,
  agentRegistryPlugin,
  agentDefinitionsPlugin,
  handoffPlugin,
  runAgentPlugin,
  agentStatusPlugin,
  limitsPlugin,
  progressWidgetPlugin,
  agentViewPlugin,
  agentListViewPlugin,
];
