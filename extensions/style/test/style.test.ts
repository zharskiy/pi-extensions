import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { SETTINGS_FILE } from "../src/settings.ts";
import { createStyle, loadStyles, SECTION, STATUS_KEY } from "../src/style.ts";

const PROMPTS = resolve(import.meta.dirname, "..", "prompts");

const CONCISE = readFileSync(join(PROMPTS, "concise.md"), "utf8").trim();

const roots: string[] = [];

type Files = { user?: unknown; project?: unknown; projectTrusted?: boolean };

const setup = ({ user, project, projectTrusted = true }: Files = {}) => {
  const root = mkdtempSync(join(tmpdir(), "pi-style-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");

  roots.push(root);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });

  if (user !== undefined) {
    writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify(user));
  }

  if (project !== undefined) {
    writeFileSync(join(cwd, ".pi", SETTINGS_FILE), JSON.stringify(project));
  }

  const host = createFakeHost({ agentDir, cwd, projectTrusted });

  createStyle(host, loadStyles(PROMPTS));
  host.start();

  return { host, userFile: join(agentDir, SETTINGS_FILE) };
};

const readUser = (path: string) => JSON.parse(readFileSync(path, "utf8"));

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("style", () => {
  it("loads every markdown file of the prompts folder as a style", () => {
    expect(Array.from(loadStyles(PROMPTS).keys())).toEqual(["concise"]);
    expect(CONCISE).toMatch(/^# Output style: concise/);
  });

  it("applies no style and no status without a settings file", () => {
    const { host } = setup();

    expect(host.promptSectionCalls).toEqual([{ name: SECTION, text: undefined }]);
    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
  });

  it("applies the stored style at session start with a dim footer status", () => {
    const { host } = setup({ user: { style: "concise" } });

    expect(host.promptSections.get(SECTION)).toBe(CONCISE);
    expect(host.statuses.get(STATUS_KEY)).toBe("<dim>style concise");
  });

  it("lets a trusted project file win over the user file", () => {
    expect(setup({ user: { style: "concise" }, project: { style: "normal" } }).host.promptSections.size).toBe(
      0,
    );
    expect(
      setup({ user: { style: "normal" }, project: { style: "concise" } }).host.promptSections.get(SECTION),
    ).toBe(CONCISE);
    expect(
      setup({ project: { style: "concise" }, projectTrusted: false }).host.promptSections.get(SECTION),
    ).toBeUndefined();
  });

  it("warns once about an unknown stored style and applies none", () => {
    const { host } = setup({ user: { style: "verbose" } });

    expect(host.promptSections.size).toBe(0);
    expect(host.notices).toEqual([
      {
        message: expect.stringMatching(/^pi-style settings: .*style must be one of "concise", "normal"$/),
        level: "warning",
      },
    ]);
  });

  it("sets, persists and clears the style through the command", async () => {
    const { host, userFile } = setup();

    await host.runCommand("style", "concise");

    expect(host.promptSections.get(SECTION)).toBe(CONCISE);
    expect(host.statuses.get(STATUS_KEY)).toBe("<dim>style concise");
    expect(readUser(userFile)).toEqual({ style: "concise" });
    expect(host.notices.at(-1)).toEqual({ message: "Style: concise from the next run.", level: "info" });

    await host.runCommand("style", "normal");

    expect(host.promptSections.size).toBe(0);
    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
    expect(readUser(userFile)).toEqual({ style: "normal" });
  });

  it("writes the status only when it changes", async () => {
    const { host } = setup();

    await host.runCommand("style", "normal");
    await host.runCommand("style", "concise");
    await host.runCommand("style", "concise");

    expect(host.statusCalls.filter((call) => call.key === STATUS_KEY)).toEqual([
      { key: STATUS_KEY, text: undefined },
      { key: STATUS_KEY, text: "<dim>style concise" },
    ]);
  });

  it("reports the current and available styles without an argument", async () => {
    const { host } = setup({ user: { style: "concise" } });

    await host.runCommand("style");

    expect(host.notices).toEqual([{ message: "Style: concise (available: concise, normal)", level: "info" }]);
  });

  it("rejects an unknown style and changes nothing", async () => {
    const { host, userFile } = setup({ user: { style: "concise" } });

    await host.runCommand("style", "loud");

    expect(host.notices).toEqual([
      { message: 'Unknown style "loud" (available: concise, normal)', level: "error" },
    ]);
    expect(host.promptSections.get(SECTION)).toBe(CONCISE);
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
