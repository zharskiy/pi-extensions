import type {
  FormFactory,
  KeyPress,
  TextInput,
  ThemeLike,
  ViewComponent,
} from "../../platform/pi-adapter/index.ts";

export type FakeForm = {
  view: ViewComponent;
  closed: boolean;
  render(width?: number): string[];
  press(...keys: KeyPress[]): void;
  type(text: string): void;
};

const fakeTextInput = (): TextInput => {
  let text = "";
  let submit: ((text: string) => void) | undefined;

  return {
    render: () => [`> ${text}`],
    handleKey: (key) => {
      if (key.name === "enter") {
        submit?.(text);
        return;
      }

      if (key.name === "backspace") {
        text = text.slice(0, -1);
        return;
      }

      if (key.char) {
        text += key.char;
      }
    },
    setText: (value) => {
      text = value;
    },
    onSubmit: (handler) => {
      submit = handler;
    },
  };
};

export const openFakeForm = <T>(
  factory: FormFactory<T>,
  theme: ThemeLike,
  signal: AbortSignal | undefined,
  register: (form: FakeForm) => void,
) =>
  new Promise<T | undefined>((resolve) => {
    const close = (result: T | undefined) => {
      if (form.closed) {
        return;
      }

      form.closed = true;
      signal?.removeEventListener("abort", abort);
      form.view.dispose?.();
      resolve(result);
    };

    const abort = () => close(undefined);

    const form: FakeForm = {
      view: { render: () => [], handleKey: () => {} },
      closed: false,
      render: (width = 80) => form.view.render(width),
      press: (...keys) => {
        keys.forEach((key) => {
          if (!form.closed) {
            form.view.handleKey(key);
          }
        });
      },
      type: (text) => {
        form.press(...Array.from(text).map((char): KeyPress => ({ name: "other", char, raw: char })));
      },
    };

    form.view = factory({
      theme,
      requestRender: () => {},
      done: close,
      createTextInput: fakeTextInput,
    });

    signal?.addEventListener("abort", abort, { once: true });
    register(form);
  });
