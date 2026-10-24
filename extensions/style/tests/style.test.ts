import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHost } from "../../../test-framework/index.ts";
import { createStyle } from "../api/plugin.ts";
import { SETTINGS_FILE } from "../core/settings.ts";
import { SECTION } from "../core/style.ts";
import { loadStyles, parseStyle, type Style } from "../core/styles.ts";

const TERSE = "Answer tersely.";

const STYLES: ReadonlyMap<string, Style> = new Map([
  ["concise", { prompt: TERSE, description: "short, result-first replies" }],
]);

const roots: string[] = [];

const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-style-"));

  roots.push(root);

  return root;
};

type Files = {
  user?: unknown;
  project?: unknown;
  projectTrusted?: boolean;
  mode?: "tui" | "print";
  blocked?: boolean;
};

const setup = ({ user, project, projectTrusted = true, mode = "tui", blocked = false }: Files = {}) => {
  const root = temp();
  const agentDir = blocked ? join(root, "blocked", "agent") : join(root, "agent");
  const cwd = join(root, "project");

  mkdirSync(join(cwd, ".pi"), { recursive: true });

  if (blocked) {
    writeFileSync(join(root, "blocked"), "");
  } else {
    mkdirSync(agentDir, { recursive: true });
  }

  if (user !== undefined) {
    writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify(user));
  }

  if (project !== undefined) {
    writeFileSync(join(cwd, ".pi", SETTINGS_FILE), JSON.stringify(project));
  }

  const host = createFakeHost({ agentDir, cwd, projectTrusted, mode });

  createStyle(host, STYLES);
  host.start();

  return { host, userFile: join(agentDir, SETTINGS_FILE) };
};

const readUser = (path: string) => JSON.parse(readFileSync(path, "utf8"));

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("style files", () => {
  it("loads every markdown file of a folder as a style except normal, its description taken from the front matter", () => {
    const dir = temp();

    writeFileSync(join(dir, "terse.md"), "---\ndescription: few words\n---\n\nBe terse.\n");
    writeFileSync(join(dir, "plain.md"), "Be plain.\n");
    writeFileSync(join(dir, "normal.md"), "Ignored.\n");
    writeFileSync(join(dir, "notes.txt"), "Ignored.\n");

    expect(Array.from(loadStyles(dir))).toEqual([
      ["plain", { prompt: "Be plain.", description: undefined }],
      ["terse", { prompt: "Be terse.", description: "few words" }],
    ]);
  });

  it("strips the front matter from the prompt and trims the description", () => {
    expect(parseStyle("---\ntitle: x\ndescription:  terse answers \n---\n\n# Body\n")).toEqual({
      prompt: "# Body",
      description: "terse answers",
    });
  });

  it("strips front matter with CRLF line endings", () => {
    expect(parseStyle("---\r\ndescription: crlf\r\n---\r\nBody")).toEqual({
      prompt: "Body",
      description: "crlf",
    });
  });

  it("keeps a file without front matter whole", () => {
    expect(parseStyle("# Body\n\n---\n")).toEqual({ prompt: "# Body\n\n---", description: undefined });
  });

  it("treats an empty description as none", () => {
    expect(parseStyle("---\ndescription:\n---\nBody")).toEqual({ prompt: "Body", description: undefined });
  });
});

describe("style", () => {
  it("applies no style without a settings file", () => {
    const { host } = setup();

    expect(host.promptSections.size).toBe(0);
  });

  it("never sets a footer status", async () => {
    const { host } = setup({ user: { style: "concise" } });

    await host.runCommand("style", "normal");

    expect(host.statusCalls).toEqual([]);
  });

  it("applies the stored style at session start", () => {
    const { host } = setup({ user: { style: "concise" } });

    expect(host.promptSections.get(SECTION)).toBe(TERSE);
  });

  it("lets a trusted project's normal win over the user file", () => {
    const { host } = setup({ user: { style: "concise" }, project: { style: "normal" } });

    expect(host.promptSections.size).toBe(0);
  });

  it("lets a trusted project's style win over the user file", () => {
    const { host } = setup({ user: { style: "normal" }, project: { style: "concise" } });

    expect(host.promptSections.get(SECTION)).toBe(TERSE);
  });

  it("ignores the project file of an untrusted project", () => {
    const { host } = setup({ project: { style: "concise" }, projectTrusted: false });

    expect(host.promptSections.size).toBe(0);
  });

  it("warns about an unknown stored style and applies none", () => {
    const { host } = setup({ user: { style: "verbose" } });

    expect(host.promptSections.size).toBe(0);
    expect(host.notices).toEqual([
      {
        message: expect.stringMatching(/^pi-style settings: .*style must be one of "concise", "normal"$/),
        level: "warning",
      },
    ]);
  });

  it("warns about the same bad settings file once across session starts", () => {
    const { host } = setup({ user: { style: "verbose" } });

    host.start();

    expect(host.notices).toHaveLength(1);
  });

  it("sets, persists and clears the style through the command", async () => {
    const { host, userFile } = setup();

    await host.runCommand("style", "concise");

    expect(host.promptSections.get(SECTION)).toBe(TERSE);
    expect(readUser(userFile)).toEqual({ style: "concise" });
    expect(host.notices.at(-1)).toEqual({ message: "Style: concise from the next run.", level: "info" });

    await host.runCommand("style", "normal");

    expect(host.promptSections.size).toBe(0);
    expect(readUser(userFile)).toEqual({ style: "normal" });
  });

  it("warns when the choice cannot be saved and still applies the style", async () => {
    const { host } = setup({ blocked: true });

    await host.runCommand("style", "concise");

    expect(host.promptSections.get(SECTION)).toBe(TERSE);
    expect(host.notices).toContainEqual({
      message: expect.stringMatching(/^pi-style: cannot save .*pi-style\.json: /),
      level: "warning",
    });
  });

  it("opens a list of every style with its description and the current one marked and selected", async () => {
    const { host } = setup({ user: { style: "concise" } });

    const running = host.runCommand("style");
    const lines = host.form().render(60);
    const concise = lines.find((line) => line.includes("concise"));
    const normal = lines.find((line) => line.includes("normal"));

    expect(concise).toContain("short, result-first replies");
    expect(concise).toContain("✓");
    expect(concise).toContain("›");
    expect(normal).toContain("no style, pi's default replies");
    expect(normal).not.toContain("✓");
    expect(normal).not.toContain("›");

    host.form().press({ name: "escape" });
    await running;
  });

  it("applies and saves the style picked in the list", async () => {
    const { host, userFile } = setup();

    const running = host.runCommand("style");
    const form = host.form();
    const normal = form.render(60).find((line) => line.includes("normal"));

    expect(normal).toContain("✓");
    expect(normal).toContain("›");

    form.press({ name: "up" }, { name: "enter" });
    await running;

    expect(host.promptSections.get(SECTION)).toBe(TERSE);
    expect(readUser(userFile)).toEqual({ style: "concise" });
    expect(host.notices).toEqual([{ message: "Style: concise from the next run.", level: "info" }]);
  });

  it("changes nothing when the list is cancelled", async () => {
    const { host, userFile } = setup({ user: { style: "concise" } });

    const running = host.runCommand("style");

    host.form().press({ name: "down" }, { name: "escape" });
    await running;

    expect(host.promptSections.get(SECTION)).toBe(TERSE);
    expect(readUser(userFile)).toEqual({ style: "concise" });
    expect(host.notices).toEqual([]);
  });

  it("warns about the project file after a pick from the list", async () => {
    const { host } = setup({ project: { style: "concise" } });

    const running = host.runCommand("style");

    host.form().press({ name: "other", char: "2", raw: "2" });
    await running;

    expect(host.promptSections.size).toBe(0);
    expect(host.notices.at(-1)?.level).toBe("warning");
  });

  it("reports the current and available styles without an argument outside the interactive terminal", async () => {
    const { host } = setup({ user: { style: "concise" }, mode: "print" });

    await host.runCommand("style");

    expect(host.forms).toEqual([]);
    expect(host.notices).toEqual([{ message: "Style: concise (available: concise, normal)", level: "info" }]);
  });

  it("rejects an unknown style and changes nothing", async () => {
    const { host, userFile } = setup({ user: { style: "concise" } });

    await host.runCommand("style", "loud");

    expect(host.notices).toEqual([
      { message: 'Unknown style "loud" (available: concise, normal)', level: "error" },
    ]);

    expect(host.promptSections.get(SECTION)).toBe(TERSE);
    expect(readUser(userFile)).toEqual({ style: "concise" });
  });

  it("applies the style live but warns that the project file wins at the next session start", async () => {
    const { host, userFile } = setup({ project: { style: "concise" } });

    await host.runCommand("style", "normal");

    expect(host.promptSections.size).toBe(0);
    expect(readUser(userFile)).toEqual({ style: "normal" });
    expect(host.notices.at(-1)).toEqual({
      message: `Style: normal from the next run. .pi/${SETTINGS_FILE} sets "concise" and wins at the next session start.`,
      level: "warning",
    });
  });

  it("completes the available styles plus normal", () => {
    const { host } = setup();
    const complete = host.commands.get("style")?.complete;

    expect(complete?.("")).toEqual([
      { value: "concise", label: "concise" },
      { value: "normal", label: "normal" },
    ]);

    expect(complete?.("n")).toEqual([{ value: "normal", label: "normal" }]);
  });
});
