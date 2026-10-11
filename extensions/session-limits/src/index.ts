import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPiExtension } from "./adapter/pi-adapter.ts";
import { createLimits } from "./limits.ts";
import { watchSettings } from "./settings.ts";

export default createPiExtension((host, paths) => {
  const ratios = watchSettings(host);
  const template = readFileSync(join(paths.packageRoot, "prompts", "handoff.md"), "utf8");

  createLimits({ host, template, ratios });
});
