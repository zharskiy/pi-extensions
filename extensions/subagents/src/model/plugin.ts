import type {
  Plugin as CorePlugin,
  PluginContext as CorePluginContext,
  Services as CoreServices,
} from "../../../../core/manager/plugin.ts";
import type { BusEvents } from "./events.ts";
import type { Settings } from "./settings.ts";
import type { ServiceMap } from "./types.ts";

export type Plugin = CorePlugin<BusEvents, ServiceMap, Settings>;

export type PluginContext = CorePluginContext<BusEvents, ServiceMap, Settings>;

export type Services = CoreServices<ServiceMap>;
