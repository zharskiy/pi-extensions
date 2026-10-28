import type { Host } from "../../../platform/pi-adapter/index.ts";

export const watchChannel = <T>(
  host: Host,
  channel: string,
  parse: (data: unknown) => T | undefined,
  changed: () => void,
) => {
  let latest: T | undefined;

  host.subscribe(channel, (data) => {
    const parsed = parse(data);

    if (!parsed) {
      return;
    }

    latest = parsed;
    changed();
  });

  return () => latest;
};
