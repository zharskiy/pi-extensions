import type { KeyPress } from "../../../platform/pi-adapter/index.ts";
import { keyPress } from "../../../platform/pi-adapter/ui/key-events.ts";

export const typed = (data: string): KeyPress => keyPress(data, { matches: () => false });
