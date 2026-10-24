import { selectForm } from "../../../core/manager/select.ts";
import type { Host } from "../../../pi-adapter/index.ts";
import { NORMAL, NORMAL_DESCRIPTION, type Style } from "./styles.ts";

export const pickStyle = (host: Host, styles: ReadonlyMap<string, Style>, current: string) => {
  const names = [...styles.keys(), NORMAL];

  const options = names.map((name) => ({
    value: name,
    label: name,
    description: name === NORMAL ? NORMAL_DESCRIPTION : styles.get(name)?.description,
    mark: name === current ? "✓" : undefined,
  }));

  return host.ui.showForm(selectForm({ title: "Output style", options, selected: names.indexOf(current) }));
};
