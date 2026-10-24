# style structure

```
extensions/style/
├── index.ts               # pi entry: re-exports the default of api/extension.ts
├── api/
│   ├── extension.ts       # createManagedExtension (namespace pi-style, one plugin)
│   └── plugin.ts          # createStyle (/style command, session start, settings wiring), stylePlugin (loads prompts/ from ctx.paths.root)
├── core/
│   ├── style.ts           # SECTION, createStyleSection (style names, current style, setPromptSection)
│   ├── styles.ts          # Style, NORMAL, parseStyle (front matter), loadStyles
│   └── settings.ts        # SETTINGS_FILE, readStyleSettings (user and project), saveStyle (user file)
├── ui/
│   └── pick.ts            # pickStyle: the selectForm list shown through showForm
├── prompts/
│   └── concise.md         # one file per style, front matter `description:`
├── tests/
│   └── style.test.ts      # command, picker, settings files, style loading
├── README.md
├── ARCHITECTURE.md
└── STRUCTURE.md
```
