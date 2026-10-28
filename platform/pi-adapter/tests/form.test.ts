import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainPiTheme } from "../../../test/framework/pi/index.ts";
import type { FormApi, KeyPress, TextInput, ViewComponent } from "../index.ts";
import { createShowForm } from "../ui/form.ts";
import { OVERLAY_POLL_MS } from "../ui/overlay.ts";

const ESC = String.fromCharCode(27);

type Shown = {
  component: {
    render(width: number): string[];
    handleInput(data: string): void;
    dispose?(): void;
    focused: boolean;
  };
  options: unknown;
  closed: boolean;
  result?: unknown;
};

const theme = plainPiTheme;

const formContext = (mode = "tui") => {
  const shown: Shown[] = [];
  const tui = {
    overlay: false,
    terminal: { rows: 40 },
    requestRender: () => {},
    hasOverlay: () => tui.overlay,
  };
  const ctx = {
    mode,
    ui: {
      custom: (factory: (...args: unknown[]) => Shown["component"], options: unknown) =>
        new Promise((resolve) => {
          const entry = { options, closed: false } as Shown;
          const done = (result: unknown) => {
            entry.closed = true;
            entry.result = result;
            resolve(result);
            entry.component.dispose?.();
          };

          shown.push(entry);
          entry.component = factory(tui, theme, { matches: () => false }, done);
        }),
    },
  } as unknown as ExtensionContext;
  const showForm = createShowForm(
    () => (ctx.mode === "tui" ? ctx : undefined),
    () => tui,
  );

  return { shown, tui, showForm };
};

const recordingView = (keys: KeyPress[], lines: string[] = []): ViewComponent => ({
  render: () => lines,
  handleKey: (key) => {
    keys.push(key);
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showForm", () => {
  it("resolves undefined outside tui without showing anything", async () => {
    const { shown, showForm } = formContext("rpc");

    expect(await showForm(() => recordingView([]))).toBeUndefined();
    expect(shown).toEqual([]);
  });

  it("shows the form inline, names keys, cuts lines to the width and resolves with done", async () => {
    const { shown, showForm } = formContext();
    const keys: KeyPress[] = [];
    let api: FormApi<string> | undefined;

    const pending = showForm<string>((form) => {
      api = form;
      return recordingView(keys, ["a long line of text"]);
    });

    await vi.waitFor(() => expect(shown).toHaveLength(1));

    const entry = shown[0] as Shown;

    entry.component.handleInput(`${ESC}[Z`);
    entry.component.handleInput("\t");
    entry.component.handleInput("2");
    api?.done("picked");

    expect(await pending).toBe("picked");
    expect(entry.options).toBeUndefined();
    expect(entry.component.render(6)).toEqual([truncateToWidth("a long line of text", 6, "...")]);
    expect(keys.map((key) => [key.name, key.char])).toEqual([
      ["backTab", undefined],
      ["tab", undefined],
      ["other", "2"],
    ]);
    expect(api?.theme.wrap("one two three", 7)).toEqual(["one two", "three"]);
  });

  it("waits until no overlay is visible before showing the form", async () => {
    vi.useFakeTimers();

    const { shown, tui, showForm } = formContext();

    tui.overlay = true;

    const pending = showForm<string>((form) => {
      form.done("ok");
      return recordingView([]);
    });

    await vi.advanceTimersByTimeAsync(OVERLAY_POLL_MS * 3);

    expect(shown).toEqual([]);

    tui.overlay = false;
    await vi.advanceTimersByTimeAsync(OVERLAY_POLL_MS);

    expect(await pending).toBe("ok");
    expect(shown).toHaveLength(1);
  });

  it("resolves undefined when the signal aborts while an overlay is up, without showing the form", async () => {
    vi.useFakeTimers();

    const { shown, tui, showForm } = formContext();
    const controller = new AbortController();

    tui.overlay = true;

    const pending = showForm(() => recordingView([]), { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(OVERLAY_POLL_MS);
    controller.abort();

    expect(await pending).toBeUndefined();

    tui.overlay = false;
    await vi.advanceTimersByTimeAsync(OVERLAY_POLL_MS * 2);

    expect(shown).toEqual([]);
  });

  it("closes the open form with undefined when the signal aborts, and disposes the view", async () => {
    const { shown, showForm } = formContext();
    const controller = new AbortController();
    let disposed = false;

    const pending = showForm<string>(
      () => ({
        render: () => [],
        handleKey: () => {},
        dispose: () => {
          disposed = true;
        },
      }),
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(shown).toHaveLength(1));
    controller.abort();

    expect(await pending).toBeUndefined();
    expect(shown[0]?.closed).toBe(true);
    expect(disposed).toBe(true);
  });

  it("resolves undefined at once for an aborted signal", async () => {
    const { shown, showForm } = formContext();
    const controller = new AbortController();

    controller.abort();

    expect(await showForm(() => recordingView([]), { signal: controller.signal })).toBeUndefined();
    expect(shown).toEqual([]);
  });

  it("does not show the form when the signal aborts before the form opens", async () => {
    const { shown, showForm } = formContext();
    const controller = new AbortController();

    const pending = showForm(() => recordingView([]), { signal: controller.signal });

    controller.abort();

    expect(await pending).toBeUndefined();
    expect(shown).toEqual([]);
  });

  it("text inputs forward raw keys to pi-tui's Editor, submit on Enter and follow the form's focus", async () => {
    const { shown, showForm } = formContext();
    const submitted: string[] = [];
    let input: TextInput | undefined;

    void showForm<string>((form) => {
      const created = form.createTextInput();

      input = created;
      created.onSubmit((text) => submitted.push(text));

      return {
        render: (width) => created.render(width),
        handleKey: (key) => created.handleKey(key),
      };
    });

    await vi.waitFor(() => expect(shown).toHaveLength(1));

    const entry = shown[0] as Shown;

    ["h", "i", "!", "\x7f"].forEach((data) => {
      entry.component.handleInput(data);
    });

    expect(entry.component.render(20).join("\n")).not.toContain(CURSOR_MARKER);

    entry.component.focused = true;

    expect(entry.component.render(20).join("\n")).toContain(CURSOR_MARKER);

    entry.component.handleInput("\r");

    expect(submitted).toEqual(["hi"]);

    input?.setText("again");
    entry.component.handleInput("\r");

    expect(submitted).toEqual(["hi", "again"]);
  });
});
