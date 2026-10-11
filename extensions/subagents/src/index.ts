import { join, resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createExtensionManager } from "../../../core/manager/extension-manager.ts";
import { NAMESPACE } from "./model/paths.ts";
import {
  applySettings,
  defaultSettings,
  projectSettingsPath,
  readSettings,
  userSettingsPath,
} from "./model/settings.ts";
import { plugins } from "./plugins.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host, runtime, paths) => {
    const user = readSettings(userSettingsPath(paths.agentDir));
    const settings = applySettings(defaultSettings(), user.patch);

    host.onSessionStart((info) => {
      const project = info.projectTrusted ? readSettings(projectSettingsPath(info.cwd)) : undefined;
      const fresh = readSettings(userSettingsPath(info.agentDir));

      applySettings(settings, { ...fresh.patch, ...project?.patch });

      const notifyError = (message: string) => {
        host.ui.notify(`${NAMESPACE} settings: ${message}`, "warning");
      };

      fresh.errors.forEach(notifyError);
      project?.errors.forEach(notifyError);
    });

    const manager = createExtensionManager({
      host,
      runtime,
      settings,
      plugins,
      root: paths.root,
      disabled: settings.disabledPlugins,
      onError: (error) =>
        host.ui.notify(`${NAMESPACE}: ${error instanceof Error ? error.message : String(error)}`, "error"),
    });

    host.onSessionShutdown(async () => {
      await manager.disableAll();
    });
  },
  { root, namespace: NAMESPACE, childExclude: [join(root, "src")] },
);
