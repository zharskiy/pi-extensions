import type { MessageRender } from "../../../platform/pi-adapter/index.ts";
import { EXPAND_BINDING } from "../../../platform/ui-kit/index.ts";
import { seedRow } from "./seed-row.ts";

export const seedMessage =
  (keyText: (binding: string) => string): MessageRender =>
  (message, width, expanded, theme) =>
    seedRow(message.text, expanded, keyText(EXPAND_BINDING))(width, theme);
