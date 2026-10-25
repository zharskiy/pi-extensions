import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "../../../platform/pi-adapter/index.ts";
import { LIMITS_CHANNEL, type Limits, type Plugin } from "../../../platform/shared/index.ts";
import { HANDOFF_TYPE, watchLimits } from "../core/limits.ts";
import { seedMessage } from "../ui/limit-messages.ts";
import { segmentFor } from "../ui/threshold-text.ts";

type LimitsOptions = {
  host: Host;
  template: string;
  limits: () => Limits;
  releaseDelayMs?: number;
};

export const createLimits = ({ host, template, limits, releaseDelayMs }: LimitsOptions) => {
  host.registerMessageRenderer(
    HANDOFF_TYPE,
    seedMessage((binding) => host.ui.keyText(binding)),
  );

  watchLimits({ host, template, limits, segment: segmentFor, releaseDelayMs });
};

export const sessionLimitsPlugin: Plugin<never, never, Limits> = {
  id: "session-limits",
  enable({ host, settings, paths }) {
    const template = readFileSync(join(paths.root, "prompts", "handoff.md"), "utf8");

    createLimits({ host, template, limits: () => settings });

    host.onSessionStart(() => {
      host.publish(LIMITS_CHANNEL, { ...settings });
    });

    return undefined;
  },
};
