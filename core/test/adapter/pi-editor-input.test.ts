import type { AutocompleteProviderFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createEditorInput } from "../../../pi-adapter/editor/pi-editor-input.ts";

type Captured = (tui: unknown, theme: unknown) => unknown;

type Focused = {
  handleInput?(data: string): void;
  getText?(): string;
  getValue?(): string;
  onSubmit?(text: string): void;
};

const fakeContext = (mode = "tui", focused: Focused | null = null) => {
  const record = {
    texts: [] as string[],
    widgets: [] as (string | undefined)[],
    factories: [] as AutocompleteProviderFactory[],
    inputs: [] as ((data: string) => unknown)[],
    editorText: "",
    editorReads: 0,
  };

  const ctx = {
    mode,
    ui: {
      onTerminalInput: (handler: (data: string) => unknown) => {
        record.inputs.push(handler);
        return () => {};
      },
      getEditorText: () => {
        record.editorReads += 1;
        return record.editorText;
      },
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

  it("reads the editor text only on the submit key", () => {
    const { record, input } = fakeContext();

    input.onEditorSubmit(() => undefined);
    record.inputs[0]("a");
    record.inputs[0]("\u001b[A");
    record.inputs[0]("\r");

    expect(record.editorReads).toBe(1);
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

  it("passes triggers, suggestions and file completion through bound to the inner provider", async () => {
    const { record, input } = fakeContext();
    const sentinel = { items: [], prefix: "@" };

    const provider: AutocompleteProvider = {
      triggerCharacters: ["@"],
      getSuggestions: async () => sentinel,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
      shouldTriggerFileCompletion() {
        return this === provider;
      },
    };

    input.mapCommandCompletion(() => undefined);

    const wrapped = record.factories[0](provider);

    expect(wrapped.triggerCharacters).toEqual(["@"]);
    expect(await wrapped.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal })).toBe(
      sentinel,
    );
    expect(wrapped.shouldTriggerFileCompletion?.(["@"], 0, 1)).toBe(true);
  });
});

describe("submitEditor", () => {
  it("sets the text and submits it through the focused editor without leaving a widget", async () => {
    const submitted: string[] = [];

    const { record, input } = fakeContext("tui", {
      getText: () => record.texts.at(-1) ?? "",
      onSubmit: (text) => submitted.push(text),
    });

    expect(await input.submitEditor("/new")).toBe(true);
    expect(record.texts).toEqual(["/new"]);
    expect(submitted).toEqual(["/new"]);
    expect(record.widgets.at(-1)).toBeUndefined();
  });

  it("fails when the focused component is not the editor or outside tui mode", async () => {
    const keys: string[] = [];
    const { input } = fakeContext("tui", null);
    const { input: rpc } = fakeContext("rpc");

    const { record, input: inputLike } = fakeContext("tui", {
      handleInput: (data) => keys.push(data),
      getValue: () => "/new",
    });

    expect(await input.submitEditor("/new")).toBe(false);
    expect(await rpc.submitEditor("/new")).toBe(false);
    expect(await inputLike.submitEditor("/new")).toBe(false);
    expect(keys).toEqual([]);
    expect(record.texts).toEqual(["/new"]);
  });
});
