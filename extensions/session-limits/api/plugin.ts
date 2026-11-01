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
import { KEPT_MESSAGE_ENTRY, KEPT_RULE_ENTRY } from "../core/kept-entries.ts";
import { watchLimits } from "../core/limits.ts";
import { keptMessage, keptRule } from "../ui/kept-entries.ts";
import { segmentFor } from "../ui/threshold-text.ts";

type LimitsOptions = {
  host: Host;
  limits: () => Limits;
  releaseDelayMs?: number;
};

export const createLimits = ({ host, limits, releaseDelayMs }: LimitsOptions) => {
  const keyText = (binding: string) => host.ui.keyText(binding);

  host.registerMessageRenderer(HANDOFF_REQUEST_TYPE, handoffRequestMessage(keyText));
  host.registerMessageRenderer(HANDOFF_SEED_TYPE, handoffSeedMessage(keyText));
  host.registerEntryRenderer(KEPT_RULE_ENTRY, keptRule, { previousSession: false });
  host.registerEntryRenderer(KEPT_MESSAGE_ENTRY, keptMessage, { flush: true, previousSession: false });

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
