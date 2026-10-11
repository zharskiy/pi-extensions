import { createPiExtension } from "./adapter/pi-adapter.ts";
import { createExtensionManager } from "./manager/extension-manager.ts";
import {
  applySettings,
  defaultSettings,
  projectSettingsPath,
  readSettingsFile,
  userSettingsPath,
} from "./manager/settings.ts";
import { plugins } from "./plugins.ts";

export default createPiExtension((host, runtime, paths) => {
  const user = readSettingsFile(userSettingsPath(paths.agentDir));
  const settings = applySettings(defaultSettings(), user.patch);

  host.onSessionStart((info) => {
    const project = info.projectTrusted ? readSettingsFile(projectSettingsPath(info.cwd)) : undefined;
    const fresh = readSettingsFile(userSettingsPath(info.agentDir));

    applySettings(settings, { ...fresh.patch, ...project?.patch });

    const notifyError = (message: string) => {
      host.ui.notify(`pi-subagents settings: ${message}`, "warning");
    };

    fresh.errors.forEach(notifyError);
    project?.errors.forEach(notifyError);
  });

  const manager = createExtensionManager({
    host,
    runtime,
    settings,
    plugins,
    packageRoot: paths.packageRoot,
    onError: (error) =>
      host.ui.notify(`pi-subagents: ${error instanceof Error ? error.message : String(error)}`, "error"),
  });

  host.onSessionShutdown(async () => {
    await manager.disableAll();
  });
});
