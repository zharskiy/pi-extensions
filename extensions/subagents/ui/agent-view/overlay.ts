import type { OverlayApi, ViewComponent } from "../../../../pi-adapter/index.ts";
import type { AgentRecord } from "../../core/model/types.ts";

export type OverlayStart = { kind: "list" } | { kind: "view"; id: string; found: AgentRecord };

export type ListComponent = ViewComponent & { suspend(): void; resume(): void };

type ListHooks = { open(record: AgentRecord): void; leave(): void };

export type OverlayParts = {
  list(hooks: ListHooks): ListComponent;
  view(id: string, found: AgentRecord, back: boolean, leave: () => void): ViewComponent;
};

export type AgentsOverlay = ViewComponent & { close(): void; dispose(): void };

export const createAgentsOverlay = (
  api: OverlayApi,
  start: OverlayStart,
  parts: OverlayParts,
): AgentsOverlay => {
  let list: ListComponent | undefined;
  let disposed = false;

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    current.dispose?.();

    if (list && list !== current) {
      list.dispose?.();
    }
  };

  const close = () => {
    dispose();
    api.close();
  };

  const resumeList = () => {
    list ??= parts.list({ open: showView, leave: close });
    list.resume();

    return list;
  };

  const showList = () => {
    current.dispose?.();
    current = resumeList();
    api.requestRender();
  };

  const showView = (record: AgentRecord) => {
    list?.suspend();
    current = parts.view(record.id, record, true, showList);
    api.requestRender();
  };

  let current: ViewComponent =
    start.kind === "list" ? resumeList() : parts.view(start.id, start.found, false, close);

  return {
    render: (width) => current.render(width),
    handleKey: (key) => {
      current.handleKey(key);
    },
    handleWheel: (lines) => {
      current.handleWheel?.(lines);
    },
    handleClick: (x, y) => current.handleClick?.(x, y) ?? false,
    dispose,
    close,
  };
};
