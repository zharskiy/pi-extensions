import type { Host } from "../../../platform/pi-adapter/index.ts";
import { MARKS, selectForm } from "../../../platform/ui-kit/index.ts";
import { NORMAL, NORMAL_DESCRIPTION, type Style } from "../core/styles.ts";

export const pickStyle = (
  host: Host,
  styles: ReadonlyMap<string, Style>,
  names: readonly string[],
  current: string,
) => {
  const options = names.map((name) => ({
    value: name,
    label: name,
    description: name === NORMAL ? NORMAL_DESCRIPTION : styles.get(name)?.description,
    mark: name === current ? MARKS.success : undefined,
  }));

  return host.ui.showForm(selectForm({ title: "Output style", options, selected: names.indexOf(current) }));
};
