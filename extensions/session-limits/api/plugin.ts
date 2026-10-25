import type { Host } from "../../../platform/pi-adapter/index.ts";
import {
  HANDOFF_REQUEST_TYPE,
  HANDOFF_SEED_TYPE,
  handoffTemplate,
  LIMITS_CHANNEL,
  type Limits,
  type Plugin,
} from "../../../platform/shared/index.ts";
import { handoffRequestMessage, handoffSeedMessage } from "../../../platform/ui-kit/index.ts";
import { watchLimits } from "../core/limits.ts";
import { segmentFor } from "../ui/threshold-text.ts";

type LimitsOptions = {
  host: Host;
  template: string;
  limits: () => Limits;
  releaseDelayMs?: number;
};

const LEGACY_SEED_TYPE = "pi-session-limits-handoff";

export const createLimits = ({ host, template, limits, releaseDelayMs }: LimitsOptions) => {
  const keyText = (binding: string) => host.ui.keyText(binding);

  host.registerMessageRenderer(HANDOFF_REQUEST_TYPE, handoffRequestMessage(keyText));
  host.registerMessageRenderer(HANDOFF_SEED_TYPE, handoffSeedMessage(keyText));
  host.registerMessageRenderer(LEGACY_SEED_TYPE, handoffSeedMessage(keyText));

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
