import type {
  AnyToolSpec,
  OverlayApi,
  ThemeLike,
  TranscriptPane,
  ViewComponent,
} from "../../../platform/pi-adapter/index.ts";
import { createTranscriptPane } from "../../../platform/pi-adapter/tools/transcript.ts";
import { createScrollPane } from "../../../platform/pi-adapter/ui/create-ui.ts";
import type { FakeHost } from "../fake-host.ts";
import { plainLines } from "../rendered-text.ts";
import { plainTheme } from "../themes.ts";

type OverlayOptions = { rows?: number; theme?: ThemeLike; host?: Pick<FakeHost, "tools"> };

export const createOverlayApi = ({ rows = 200, theme = plainTheme, host }: OverlayOptions = {}) => {
  const state = { closed: false, renders: 0 };
  const transcripts: TranscriptPane[] = [];

  const requestRender = () => {
    state.renders += 1;
  };

  const api: OverlayApi = {
    theme,
    rows: () => rows,
    close: () => {
      state.closed = true;
    },
    requestRender,
    toolsKey: "ctrl+o",
    createTranscript: (): TranscriptPane => {
      const pane = createTranscriptPane({ requestRender } as never, "/repo", {
        tools: [...(host?.tools.values() ?? [])] as AnyToolSpec[],
        theme: () => theme,
      });

      transcripts.push(pane);

      return pane;
    },
    createScroll: () => createScrollPane(requestRender),
  };

  return { api, state, transcripts };
};

const opened: ViewComponent[] = [];

export const openLastOverlay = (host: FakeHost, rows = 200, theme: ThemeLike = plainTheme) => {
  const factory = host.overlays.at(-1);

  if (!factory) {
    throw new Error("no overlay opened");
  }

  const { api, state, transcripts } = createOverlayApi({ rows, theme, host });
  const view = factory(api);

  opened.push(view);

  return { view, state, transcripts, lines: (width = 100) => plainLines(view.render(width)) };
};

export const disposeOverlays = () => {
  opened.splice(0).forEach((view) => {
    view.dispose?.();
  });
};
