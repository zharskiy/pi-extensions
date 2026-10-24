import type {
  AnyToolSpec,
  OverlayApi,
  ThemeLike,
  TranscriptPane,
  ViewComponent,
} from "../../pi-adapter/index.ts";
import { createTranscriptPane } from "../../pi-adapter/tools/pi-transcript.ts";
import { createScrollPane } from "../../pi-adapter/ui/pi-ui.ts";
import type { FakeHost } from "../fake-host.ts";
import { plainLines } from "../rendered-text.ts";
import { plainTheme } from "../themes.ts";

type OverlayOptions = { rows?: number; theme?: ThemeLike; host?: Pick<FakeHost, "tools"> };

export const createOverlayApi = ({ rows = 200, theme = plainTheme, host }: OverlayOptions = {}) => {
  const state = { closed: false, renders: 0 };
  const transcripts: { owner?: string }[] = [];

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
    createTranscript: (options): TranscriptPane => {
      transcripts.push(options ?? {});

      return createTranscriptPane({ requestRender } as never, "/repo", {
        tools: [...(host?.tools.values() ?? [])] as AnyToolSpec[],
        owner: options?.owner,
      });
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
