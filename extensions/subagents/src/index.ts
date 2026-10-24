import { join, resolve } from "node:path";
import { createExtensionManager } from "../../../core/manager/extension-manager.ts";
import { createPiExtension } from "../../../pi-adapter/index.ts";
import { errorText } from "./components/format.ts";
import { NAMESPACE } from "./model/paths.ts";
import { defaultSettings, disabledPlugins, reloadSettings, settingsWarning } from "./model/settings.ts";
import { plugins } from "./plugins.ts";

const root = resolve(import.meta.dirname, "..");

/** @public */
export default createPiExtension(
  (host, runtime, paths) => {
    const disabled = disabledPlugins(paths.agentDir);
    const settings = { ...defaultSettings(), disabledPlugins: disabled };

    host.onSessionStart((info) => {
      reloadSettings(settings, info, runtime, (message) =>
        host.ui.notify(settingsWarning(message), "warning"),
      );
    });

    const manager = createExtensionManager({
      host,
      runtime,
      settings,
      plugins,
      root: paths.root,
      disabled,
      onError: (error) => host.ui.notify(`${NAMESPACE}: ${errorText(error)}`, "error"),
    });

    host.onSessionShutdown(async () => {
      await manager.disableAll();
    });
  },
  { root, namespace: NAMESPACE, childExclude: [join(root, "src")], skillInventory: true },
);
