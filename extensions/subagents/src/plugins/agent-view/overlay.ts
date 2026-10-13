import type { OverlayApi, ViewComponent } from "../../../../../core/adapter/contract.ts";
import type { AgentViewOrigin } from "../../model/types.ts";

export type OverlayStart = { kind: "list" } | { kind: "view"; id: string; from: AgentViewOrigin };

export type ListComponent = ViewComponent & { suspend(): void; resume(): void };

export type ListHooks = { open(id: string): void; leave(): void; selected?: string };

export type OverlayParts = {
  list(hooks: ListHooks): ListComponent;
  /** `undefined` when the id no longer resolves. */
  view(id: string, from: AgentViewOrigin, leave: () => void): ViewComponent | undefined;
};

const EMPTY: ViewComponent = { render: () => [], handleKey: () => {} };

export type AgentsOverlay = ViewComponent & { close(): void };

export const createAgentsOverlay = (
  api: OverlayApi,
  start: OverlayStart,
  parts: OverlayParts,
): AgentsOverlay => {
  let list: ListComponent | undefined;
  let current: ViewComponent = EMPTY;
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

  const showView = (id: string) => {
    const view = parts.view(id, "list", () => showList());

    if (!view) {
      return;
    }

    list?.suspend();
    current = view;
    api.requestRender();
  };

  const showList = (selected?: string) => {
    const previous = current;

    list ??= parts.list({ open: showView, leave: close, selected });
    list.resume();

    if (previous !== list) {
      previous.dispose?.();
    }

    current = list;
    api.requestRender();
  };

  if (start.kind === "list") {
    showList();
  } else {
    const leave = start.from === "list" ? () => showList(start.id) : close;

    current = parts.view(start.id, start.from, leave) ?? {
      render: () => [],
      handleKey: (key) => {
        if (key.name === "escape") {
          close();
        }
      },
    };
  }

  return {
    render: (width) => current.render(width),
    handleKey: (key) => {
      current.handleKey(key);
    },
    handleWheel: (lines) => {
      current.handleWheel?.(lines);
    },
    dispose,
    close,
  };
};
