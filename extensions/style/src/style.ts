import type { Host, SessionInfo } from "../../../core/adapter/contract.ts";
import { reportSettingsErrors } from "../../../core/manager/settings.ts";
import { pickStyle } from "./pick.ts";
import { readStyleSettings, SETTINGS_FILE, saveStyle } from "./settings.ts";
import { NORMAL, type Style } from "./styles.ts";

export const SECTION = "output_style";

export const createStyle = (host: Host, styles: ReadonlyMap<string, Style>) => {
  const names = [...styles.keys(), NORMAL];
  let current = NORMAL;
  let projectStyle: string | undefined;
  let session: SessionInfo | undefined;

  const apply = (name: string) => {
    current = name;
    host.setPromptSection(SECTION, styles.get(name)?.prompt);
  };

  const report = reportSettingsErrors(host, "pi-style");

  host.onSessionStart((info) => {
    const stored = readStyleSettings(names, info);

    session = info;
    projectStyle = stored.project;
    report(stored.errors);
    apply(projectStyle ?? stored.user ?? NORMAL);
  });

  const choose = (name: string) => {
    const failure = session && saveStyle(session.agentDir, name);

    if (failure) {
      host.ui.notify(`pi-style: ${failure}`, "warning");
    }

    apply(name);

    if (projectStyle !== undefined) {
      host.ui.notify(
        `Style: ${name} from the next run. .pi/${SETTINGS_FILE} sets "${projectStyle}" and wins at the next session start.`,
        "warning",
      );

      return;
    }

    host.ui.notify(`Style: ${name} from the next run.`, "info");
  };

  const available = () => `available: ${names.join(", ")}`;

  const pick = async () => {
    if (host.session().mode !== "tui") {
      host.ui.notify(`Style: ${current} (${available()})`, "info");
      return;
    }

    const picked = await pickStyle(host, styles, current);

    if (picked !== undefined) {
      choose(picked);
    }
  };

  host.registerCommand("style", {
    description: `Pick the output style of the main session and every agent from a list, or set it directly: /style [${names.join("|")}]`,
    complete: (prefix) =>
      names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    run: async (args) => {
      const name = args.trim();

      if (!name) {
        await pick();
        return;
      }

      if (!names.includes(name)) {
        host.ui.notify(`Unknown style "${name}" (${available()})`, "error");
        return;
      }

      choose(name);
    },
  });
};
