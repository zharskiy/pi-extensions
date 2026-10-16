type SectionOptions = { sections: Record<string, string> };

type Section = { text: string; owner: symbol };

const SECTIONS_KEY = Symbol.for("pi-extensions.owned-prompt-sections");

const shared = globalThis as typeof globalThis & { [SECTIONS_KEY]?: Map<string, Section> };

const sharedSections = (): Map<string, Section> => (shared[SECTIONS_KEY] ??= new Map());

export const applyPromptSections = (options: SectionOptions) => {
  sharedSections().forEach(({ text }, name) => {
    options.sections[name] = text;
  });
};

export const createPromptSections = () => {
  const owner = Symbol("prompt-sections");
  const own = new Set<string>();

  const drop = (name: string) => {
    const sections = sharedSections();

    if (sections.get(name)?.owner === owner) {
      sections.delete(name);
    }

    own.delete(name);
  };

  return {
    set: (name: string, text: string | undefined) => {
      if (text === undefined) {
        drop(name);
        return;
      }

      sharedSections().set(name, { text, owner });
      own.add(name);
    },
    release: () => {
      Array.from(own).forEach(drop);
    },
  };
};
