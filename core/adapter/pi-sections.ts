type SectionOptions = { sections: Record<string, string> };

const SECTIONS_KEY = Symbol.for("pi-extensions.prompt-sections");

const shared = globalThis as typeof globalThis & { [SECTIONS_KEY]?: Map<string, string> };

const sharedSections = (): Map<string, string> => (shared[SECTIONS_KEY] ??= new Map());

export const applyPromptSections = (options: SectionOptions) => {
  sharedSections().forEach((text, name) => {
    options.sections[name] = text;
  });
};

export const createPromptSections = () => {
  const own = new Map<string, string>();

  const drop = (name: string) => {
    const sections = sharedSections();

    if (sections.get(name) === own.get(name)) {
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

      sharedSections().set(name, text);
      own.set(name, text);
    },
    release: () => {
      Array.from(own.keys()).forEach(drop);
    },
  };
};
