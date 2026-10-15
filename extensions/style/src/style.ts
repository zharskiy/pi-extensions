import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Host, SessionInfo } from "../../../core/adapter/contract.ts";
import { errorText } from "../../../core/manager/format.ts";
import {
  projectSettingsPath,
  readSettingsFile,
  type SettingsParse,
  userSettingsPath,
} from "../../../core/manager/settings.ts";
import { NORMAL, SETTINGS_FILE, type StyleSettings, styleSchema } from "./settings.ts";

export const SECTION = "output_style";

export const STATUS_KEY = "pi-style";

export const loadStyles = (dir: string): ReadonlyMap<string, string> =>
  new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith(".md") && file !== `${NORMAL}.md`)
      .sort()
      .map((file) => [basename(file, ".md"), readFileSync(join(dir, file), "utf8").trim()]),
  );

const noFile: SettingsParse<StyleSettings> = { patch: {}, errors: [] };

export const createStyle = (host: Host, styles: ReadonlyMap<string, string>) => {
  const names = [...styles.keys(), NORMAL];
  const schema = styleSchema(names);
  const reported = new Set<string>();
  const available = `available: ${names.join(", ")}`;
  let current = NORMAL;
  let shown: string | undefined;
  let projectStyle: string | undefined;
  let location: SessionInfo | undefined;

  const showStatus = (force: boolean) => {
    const status = current === NORMAL ? undefined : current;

    if (!force && status === shown) {
      return;
    }

    shown = status;
    host.ui.setStatus(STATUS_KEY, status && host.ui.style("dim", `style ${status}`));
  };

  const apply = (name: string, force: boolean) => {
    current = name;
    host.setPromptSection(SECTION, styles.get(name));
    showStatus(force);
  };

  const save = (info: SessionInfo, name: string) => {
    const path = userSettingsPath(info.agentDir, SETTINGS_FILE);

    try {
      mkdirSync(info.agentDir, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ style: name }, null, 2)}\n`);
    } catch (error) {
      host.ui.notify(`pi-style: cannot save ${path}: ${errorText(error)}`, "warning");
    }
  };

  host.onSessionStart((info) => {
    const user = readSettingsFile(schema, userSettingsPath(info.agentDir, SETTINGS_FILE));
    const project = info.projectTrusted
      ? readSettingsFile(schema, projectSettingsPath(info.cwd, SETTINGS_FILE))
      : noFile;

    location = info;
    projectStyle = project.patch.style;

    [...user.errors, ...project.errors]
      .filter((error) => !reported.has(error))
      .forEach((error) => {
        reported.add(error);
        host.ui.notify(`pi-style settings: ${error}`, "warning");
      });

    apply(projectStyle ?? user.patch.style ?? NORMAL, true);
  });

  host.registerCommand("style", {
    description: `Set the output style of the main session and every agent. Usage: /style [${names.join("|")}]`,
    complete: (prefix) =>
      names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    run: (args) => {
      const name = args.trim();

      if (!name) {
        host.ui.notify(`Style: ${current} (${available})`, "info");
        return;
      }

      if (!names.includes(name)) {
        host.ui.notify(`Unknown style "${name}" (${available})`, "error");
        return;
      }

      if (location) {
        save(location, name);
      }

      apply(name, false);

      if (projectStyle !== undefined) {
        host.ui.notify(
          `Style: ${name} from the next run. .pi/${SETTINGS_FILE} sets "${projectStyle}" and wins at the next session start.`,
          "warning",
        );
        return;
      }

      host.ui.notify(`Style: ${name} from the next run.`, "info");
    },
  });
};
