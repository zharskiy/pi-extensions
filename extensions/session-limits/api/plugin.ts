import type { Host } from "../../../platform/pi-adapter/index.ts";
import {
  HANDOFF_REQUEST_TYPE,
  HANDOFF_SEED_TYPE,
  handoffTool,
  LIMITS_CHANNEL,
  type Limits,
  type Plugin,
} from "../../../platform/shared/index.ts";
import {
  handoffRequestMessage,
  handoffSeedMessage,
  handoffToolRows,
} from "../../../platform/ui-kit/index.ts";
import { validateMainHandoff } from "../core/handoff.ts";
import { watchLimits } from "../core/limits.ts";
import { segmentFor } from "../ui/threshold-text.ts";

type LimitsOptions = {
  host: Host;
  limits: () => Limits;
  releaseDelayMs?: number;
};

const LEGACY_SEED_TYPE = "pi-session-limits-handoff";

export const createLimits = ({ host, limits, releaseDelayMs }: LimitsOptions) => {
  const keyText = (binding: string) => host.ui.keyText(binding);

  host.registerMessageRenderer(HANDOFF_REQUEST_TYPE, handoffRequestMessage(keyText));
  host.registerMessageRenderer(HANDOFF_SEED_TYPE, handoffSeedMessage(keyText));
  host.registerMessageRenderer(LEGACY_SEED_TYPE, handoffSeedMessage(keyText));

  const saving = watchLimits({ host, limits, segment: segmentFor, releaseDelayMs });

  host.registerTool(
    handoffTool({
      target: saving.target,
      validate: validateMainHandoff,
      rows: handoffToolRows(() => saving.target()?.path),
      onSaved: saving.saved,
    }),
  );
};

export const sessionLimitsPlugin: Plugin<never, never, Limits> = {
  id: "session-limits",
  enable({ host, settings }) {
    createLimits({ host, limits: () => settings });

    host.onSessionStart(() => {
      host.publish(LIMITS_CHANNEL, { ...settings });
    });

    return undefined;
  },
};
