const PRINTABLE_FROM = 0x20;

const C1_FROM = 0x7f;

const C1_TO = 0x9f;

const BIDI_CONTROL = /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const codeOf = (char: string) => char.codePointAt(0) ?? 0;

export const isControlChar = (char: string) => {
  const code = codeOf(char);

  return code < PRINTABLE_FROM || (code >= C1_FROM && code <= C1_TO) || BIDI_CONTROL.test(char);
};

const escaped = (char: string) => `\\u${codeOf(char).toString(16).padStart(4, "0").toUpperCase()}`;

export const printable = (text: string) =>
  Array.from(text)
    .map((char) => (isControlChar(char) ? escaped(char) : char))
    .join("");
