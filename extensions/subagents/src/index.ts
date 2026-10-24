import { resolve } from "node:path";
import { createManagedExtension } from "../../../extension-manager/index.ts";
import { errorText } from "./components/format.ts";
import { NAMESPACE } from "./model/paths.ts";
import { defaultSettings, disabledPlugins, reloadSettings } from "./model/settings.ts";
import { plugins } from "./plugins.ts";

const root = resolve(import.meta.dirname, "..");

export default createManagedExtension({
  namespace: NAMESPACE,
  root,
  plugins,
  settings: {
    defaults: ({ agentDir }) => ({ ...defaultSettings(), disabledPlugins: disabledPlugins(agentDir) }),
    reload: reloadSettings,
  },
  childExclude: [root],
  skillInventory: true,
  disabled: (settings) => settings.disabledPlugins,
  onError: (error, host) => host.ui.notify(`${NAMESPACE}: ${errorText(error)}`, "error"),
});
