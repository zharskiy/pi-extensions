import type { Plugin as CorePlugin } from "../../../../shared/index.ts";
import type { ServiceMap } from "./agent-record.ts";
import type { BusEvents } from "./events.ts";
import type { Settings } from "./settings.ts";

export type Plugin = CorePlugin<BusEvents, ServiceMap, Settings>;
