import type { Host } from "../../../platform/pi-adapter/index.ts";
import { handoffTemplate, LIMITS_CHANNEL, type Limits, type Plugin } from "../../../platform/shared/index.ts";
import { handoffSeedMessage } from "../../../platform/ui-kit/index.ts";
import { HANDOFF_TYPE, watchLimits } from "../core/limits.ts";
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
    handoffSeedMessage((binding) => host.ui.keyText(binding)),
  );

  watchLimits({ host, template, limits, segment: segmentFor, releaseDelayMs });
};

export const sessionLimitsPlugin: Plugin<never, never, Limits> = {
  id: "session-limits",
  enable({ host, settings }) {
    createLimits({ host, template: handoffTemplate(), limits: () => settings });

    host.onSessionStart(() => {
      host.publish(LIMITS_CHANNEL, { ...settings });
    });

    return undefined;
  },
};
