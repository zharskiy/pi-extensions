import type { AutocompleteProviderFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createEditorInput } from "../../adapter/pi-editor-input.ts";

type Captured = (tui: unknown, theme: unknown) => unknown;

const fakeContext = (mode = "tui", focused: { handleInput?(data: string): void } | null = null) => {
  const record = {
    texts: [] as string[],
    widgets: [] as (string | undefined)[],
    factories: [] as AutocompleteProviderFactory[],
    inputs: [] as ((data: string) => unknown)[],
    editorText: "",
  };

  const ctx = {
    mode,
    ui: {
      onTerminalInput: (handler: (data: string) => unknown) => {
        record.inputs.push(handler);
        return () => {};
      },
      getEditorText: () => record.editorText,
      setEditorText: (text: string) => {
        record.texts.push(text);
      },
      addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
        record.factories.push(factory);
      },
      setWidget: (key: string, content: Captured | undefined) => {
        record.widgets.push(content ? key : undefined);
        content?.({ getFocusedComponent: () => focused }, {});
      },
    },
  } as unknown as ExtensionContext;

  return { record, input: createEditorInput(() => (mode === "tui" ? ctx : undefined)) };
};

const item = (value: string): AutocompleteItem => ({ value, label: value });

const recordingProvider = () => {
  const applied: string[] = [];

  const provider: AutocompleteProvider = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol, completion) => {
      applied.push(completion.value);
      return { lines, cursorLine, cursorCol };
    },
  };

  return { applied, provider };
};

describe("onEditorSubmit", () => {
  it("replaces the editor text on the submit key only, never consuming the key", () => {
    const { record, input } = fakeContext();

    input.onEditorSubmit((text) => (text === "/clear" ? "/new" : undefined));
    record.editorText = "/clear";

    const results = [record.inputs[0]("a"), record.inputs[0]("\r")];

    record.editorText = "hello";
    record.inputs[0]("\r");

    expect(results).toEqual([undefined, undefined]);
    expect(record.texts).toEqual(["/new"]);
  });

  it("does nothing outside tui mode", () => {
    const { record, input } = fakeContext("rpc");

    input.onEditorSubmit(() => "/new")();

    expect(record.inputs).toEqual([]);
  });
});

describe("mapCommandCompletion", () => {
  it("maps slash command completions and leaves other completions alone", () => {
    const { record, input } = fakeContext();
    const { applied, provider } = recordingProvider();

    input.mapCommandCompletion((command) => (command === "/clear" ? "/new" : undefined));

    const wrapped = record.factories[0](provider);

    wrapped.applyCompletion(["/cl"], 0, 3, item("clear"), "/cl");
    wrapped.applyCompletion(["/mo"], 0, 3, item("model"), "/mo");
    wrapped.applyCompletion(["@cl"], 0, 3, item("clear"), "@cl");

    expect(applied).toEqual(["new", "model", "clear"]);
    expect(wrapped.shouldTriggerFileCompletion).toBeUndefined();
  });
});

describe("submitEditor", () => {
  it("sets the text and feeds enter to the focused component without leaving a widget", async () => {
    const keys: string[] = [];
    const { record, input } = fakeContext("tui", { handleInput: (data) => keys.push(data) });

    expect(await input.submitEditor("/new")).toBe(true);
    expect(record.texts).toEqual(["/new"]);
    expect(keys).toEqual(["\r"]);
    expect(record.widgets).toEqual(["pi-editor-input", undefined]);
  });

  it("fails when no focused component takes input or outside tui mode", async () => {
    const { input } = fakeContext("tui", null);
    const { input: rpc } = fakeContext("rpc");

    expect(await input.submitEditor("/new")).toBe(false);
    expect(await rpc.submitEditor("/new")).toBe(false);
  });
});
