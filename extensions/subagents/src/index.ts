import { join, resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createExtensionManager } from "../../../core/manager/extension-manager.ts";
import { NAMESPACE } from "./model/paths.ts";
import { applySettings, defaultSettings, disabledPlugins, loadSettings } from "./model/settings.ts";
import { plugins } from "./plugins.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host, runtime, paths) => {
    const disabled = disabledPlugins(paths.agentDir);
    const settings = applySettings(defaultSettings(), { disabledPlugins: disabled });

    host.onSessionStart((info) => {
      const loaded = loadSettings(info.agentDir, info.cwd, info.projectTrusted);

      applySettings(settings, { ...loaded.settings, disabledPlugins: disabled });

      loaded.errors.forEach((message) => {
        host.ui.notify(`${NAMESPACE} settings: ${message}`, "warning");
      });
    });

    const manager = createExtensionManager({
      host,
      runtime,
      settings,
      plugins,
      root: paths.root,
      disabled,
      onError: (error) =>
        host.ui.notify(`${NAMESPACE}: ${error instanceof Error ? error.message : String(error)}`, "error"),
    });

    host.onSessionShutdown(async () => {
      await manager.disableAll();
    });
  },
  { root, namespace: NAMESPACE, childExclude: [join(root, "src")] },
);
