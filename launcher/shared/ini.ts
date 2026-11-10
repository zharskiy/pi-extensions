export interface IniSection {
  name: string;
  entries: Array<[string, string]>;
}

export const INI_KEY = /^([^.\s[\]]+)\.([^\s[\]]+)(?:\[([0-9]+)\])?$/;

const INI_SECTION = /^\[([^\]]+)\]\s*$/;

const INI_ENTRY = /^([^\s=:;#][^=:]*?)\s*[=:]\s*(.*?)\s*$/;

const INI_CONTINUATION = /^\s+(\S.*?)\s*$/;

const INI_COMMENT = /^\s*([#;].*)?$/;

interface IniState {
  sections: IniSection[];
  last?: [string, string];
}

const iniLine = (state: IniState, line: string): IniState => {
  const continuation = INI_CONTINUATION.exec(line);

  if (continuation !== null && state.last !== undefined && !INI_COMMENT.test(line)) {
    state.last[1] = state.last[1] === "" ? (continuation[1] ?? "") : `${state.last[1]}\n${continuation[1]}`;

    return state;
  }

  if (INI_COMMENT.test(line)) {
    return { sections: state.sections };
  }

  const section = INI_SECTION.exec(line.trim());

  if (section !== null) {
    return { sections: [...state.sections, { name: (section[1] ?? "").trim(), entries: [] }] };
  }

  const entry = INI_ENTRY.exec(line);
  const current = state.sections.at(-1);

  if (entry === null || current === undefined) {
    return { sections: state.sections };
  }

  const pair: [string, string] = [(entry[1] ?? "").toLowerCase(), entry[2] ?? ""];

  current.entries.push(pair);

  return { sections: state.sections, last: pair };
};

export const parseIni = (text: string): IniSection[] =>
  text.split(/\r?\n/).reduce<IniState>(iniLine, { sections: [] }).sections;

export const iniWords = (value: string) => value.split(/\s+/).filter((word) => word !== "");

export const iniValue = (text: string, key: string) => {
  const match = INI_KEY.exec(key);

  if (match === null) {
    return undefined;
  }

  const [, section, name, index] = match;
  const value = parseIni(text)
    .filter((entry) => entry.name === section)
    .flatMap((entry) => entry.entries)
    .findLast(([entryName]) => entryName === name?.toLowerCase())?.[1];

  return value === undefined || index === undefined ? value : iniWords(value)[Number(index)];
};
