import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { char, type FakeForm, flushMicrotasks, key } from "../../../../../test-framework/index.ts";
import { agentDefinitionsPlugin } from "../../../api/plugins/agent-definitions.ts";
import { agentRegistryPlugin } from "../../../api/plugins/agent-registry.ts";
import { agentSetupPlugin } from "../../../api/plugins/agent-setup.ts";
import { agentViewPlugin } from "../../../api/plugins/agent-view.ts";
import { createHarness } from "../../support/subagents-harness.ts";

const APPLIES = "agents started from now on use it";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};

const setup = ({ trusted = false } = {}) => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    agentSetupPlugin,
    agentViewPlugin,
  ]);
  const { host, runtime, services } = harness;

  host.info.projectTrusted = trusted;
  runtime.skills = ["docs", "search"];

  const projectFile = join(host.info.cwd, ".pi", "pi-subagents.json");
  const userFile = join(host.info.agentDir, "pi-subagents.json");
  const noticesOf = (level: string) =>
    host.notices.filter((notice) => notice.level === level).map((notice) => notice.message);
  const definition = (name: string) => services.require("definitions").get(name);

  const openForm = async () => {
    const run = host.runCommand("agents", "setup");

    await flushMicrotasks();

    return { run, form: host.form() };
  };

  return { ...harness, projectFile, userFile, noticesOf, definition, openForm };
};

const showsAgent = (form: FakeForm, name: string) =>
  form.render(400).some((line) => line.startsWith(` ${name} `));

const goToAgent = (form: FakeForm, name: string) => {
  Array.from({ length: 20 }).forEach(() => {
    if (!showsAgent(form, name)) {
      form.press(key("tab"));
    }
  });

  expect(showsAgent(form, name)).toBe(true);
};

const goToSubmit = (form: FakeForm) => {
  Array.from({ length: 20 }).forEach(() => {
    if (!form.render(400).some((line) => line.includes("Save to:"))) {
      form.press(key("tab"));
    }
  });

  expect(form.render(400).some((line) => line.includes("Save to:"))).toBe(true);
};

describe("/agents setup form", () => {
  it("writes changed fields into the trusted project's file, keeps other keys and applies them", async () => {
    const { projectFile, openForm, definition, noticesOf } = setup({ trusted: true });

    writeJson(projectFile, { maxConcurrent: 2, agents: { scout: { thinking: "low" } } });

    const { run, form } = await openForm();

    goToAgent(form, "general");
    form.press(key("enter"), key("home"), key("enter"));
    form.press(key("down"), key("enter"), key("home"), key("enter"));
    form.press(key("down"), key("enter"), char("n"), key("space"), key("enter"));
    goToSubmit(form);
    form.press(key("enter"));
    await run;

    expect(form.closed).toBe(true);
    expect(readJson(projectFile)).toEqual({
      maxConcurrent: 2,
      agents: {
        scout: { thinking: "low" },
        general: { model: "inherit", thinking: "off", skills: ["docs"] },
      },
    });
    expect(definition("general")).toMatchObject({ model: undefined, thinking: "off", skills: ["docs"] });
    expect(definition("scout")?.thinking).toBe("low");
    expect(noticesOf("info")).toEqual([
      `pi-subagents: saved general (model, thinking, skills) to ${projectFile}; ${APPLIES}`,
    ]);
  });

  it("shows each skill's description on its row and the full text of the one under the cursor", async () => {
    const { runtime, userFile, openForm } = setup();

    runtime.skills = ["review", "docs", "search"];
    runtime.skillDescriptions = {
      review:
        "Reviews diffs for correctness, missing tests, risky changes and unclear naming, then reports every finding grouped by severity with file and line.",
      docs: "Writes docs",
      search: "Searches the web and cites sources",
    };

    const { run, form } = await openForm();

    goToAgent(form, "general");
    form.press(key("down"), key("down"), key("enter"));

    const lines = form.render(33);
    const list = lines.slice(lines.indexOf(" Skills") + 1);

    expect(list.slice(0, 3)).toEqual([
      " › [ ] review  Reviews diffs f...",
      "   [ ] docs  Writes docs",
      "   [ ] search  Searches the we...",
    ]);
    expect(list.slice(3, 8)).toEqual([
      "",
      " Reviews diffs for correctness,",
      " missing tests, risky changes and",
      " unclear naming, then reports ...",
      "",
    ]);

    form.press(key("down"));
    expect(form.render(33).some((line) => line.startsWith(" Reviews diffs"))).toBe(false);
    expect(form.render(33).some((line) => line.startsWith(" Searches"))).toBe(false);

    form.press(key("down"));
    expect(form.render(33)).toContain(" Searches the web and cites");
    expect(form.render(33)).toContain(" sources");

    form.press(key("space"), key("enter"));
    goToSubmit(form);
    form.press(key("enter"));
    await run;

    expect(readJson(userFile)).toEqual({ agents: { general: { skills: ["search"] } } });
  });

  it("refuses the project file in an untrusted project and writes the user file instead", async () => {
    const { projectFile, userFile, openForm, definition } = setup();
    const { run, form } = await openForm();

    goToAgent(form, "scout");
    form.press(key("down"), key("enter"), key("end"), key("enter"));
    goToSubmit(form);
    form.press(key("up"), key("enter"));

    expect(form.closed).toBe(false);
    expect(form.render(400).some((line) => line.includes("this project is not trusted"))).toBe(true);

    form.press(key("down"), key("enter"));
    await run;

    expect(existsSync(projectFile)).toBe(false);
    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "max" } } });
    expect(definition("scout")?.thinking).toBe("max");
  });

  it("warns when the trusted project's file sets a field written to the user file", async () => {
    const { projectFile, userFile, openForm, noticesOf } = setup({ trusted: true });

    writeJson(projectFile, { agents: { scout: { thinking: "low" } } });

    const { run, form } = await openForm();

    goToAgent(form, "scout");
    form.press(key("down"), key("enter"), key("end"), key("enter"));
    goToSubmit(form);
    form.press(key("down"), key("enter"));
    await run;

    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "max" } } });
    expect(noticesOf("warning")).toContain(
      `pi-subagents: ${projectFile} also sets agents.scout.thinking and wins`,
    );
  });

  it("closes without writing when nothing changed or on Escape", async () => {
    const { projectFile, userFile, openForm, noticesOf } = setup({ trusted: true });
    const first = await openForm();

    first.form.press(key("backTab"), key("enter"));
    await first.run;

    const second = await openForm();

    second.form.press(key("escape"));
    await second.run;

    expect(noticesOf("info")).toEqual(["pi-subagents: nothing changed"]);
    expect(existsSync(projectFile) || existsSync(userFile)).toBe(false);
  });

  it("does not overwrite a settings file that is not valid JSON", async () => {
    const { projectFile, openForm, noticesOf } = setup({ trusted: true });

    writeJson(projectFile, "{ not json");

    const { run, form } = await openForm();

    form.press(key("down"), key("enter"), key("home"), key("enter"), key("backTab"), key("enter"));
    await run;

    expect(readFileSync(projectFile, "utf8")).toBe("{ not json");
    expect(noticesOf("error")).toHaveLength(1);
    expect(noticesOf("error")[0]).toContain(`cannot save ${projectFile}`);
  });

  it("refuses the form outside the terminal UI and names the files to edit", async () => {
    const { host, projectFile, userFile, noticesOf } = setup();

    host.info.mode = "rpc";
    await host.runCommand("agents", "setup");

    expect(host.forms).toEqual([]);
    expect(noticesOf("error")).toHaveLength(1);
    expect(noticesOf("error")[0]).toContain(projectFile);
    expect(noticesOf("error")[0]).toContain(userFile);
  });
});

describe("/agents setup one-line form", () => {
  it("sets fields of one agent in the user file and applies them", async () => {
    const { host, userFile, definition } = setup();

    await host.runCommand("agents", "setup scout thinking=high skills=none scope=user");

    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "high", skills: [] } } });
    expect(definition("scout")?.thinking).toBe("high");
  });

  it("writes the user file by default in an untrusted project", async () => {
    const { host, userFile, definition } = setup();

    await host.runCommand("agents", "setup scout thinking=low");

    expect(readJson(userFile)).toEqual({ agents: { scout: { thinking: "low" } } });
    expect(definition("scout")?.thinking).toBe("low");
  });

  it("writes the trusted project's file by default with the model and its thinking suffix", async () => {
    const { host, projectFile, definition } = setup({ trusted: true });

    await host.runCommand("agents", "setup scout model=fake/model:low skills=docs,search");

    expect(readJson(projectFile)).toEqual({
      agents: { scout: { model: "fake/model", thinking: "low", skills: ["docs", "search"] } },
    });
    expect(definition("scout")).toMatchObject({ model: "fake/model", thinking: "low" });
  });

  it("reports bad requests and writes nothing", async () => {
    const { host, projectFile, userFile, noticesOf } = setup();
    const requests = [
      "setup nobody thinking=high",
      "setup scout thinking=extreme scope=user",
      "setup scout skills=ghost scope=user",
      "setup scout model=locked/lyra-9-0 scope=user",
      "setup scout color=blue scope=user",
      "setup scout",
      "setup scout thinking=high scope=project",
    ];

    await requests.reduce<Promise<void>>(
      (chain, request) => chain.then(() => host.runCommand("agents", request)),
      Promise.resolve(),
    );

    expect(noticesOf("error")).toHaveLength(requests.length);
    expect(noticesOf("error").at(-1)).toContain("not trusted");
    expect(existsSync(projectFile) || existsSync(userFile)).toBe(false);
  });
});

describe("/agents setup completion", () => {
  it("offers setup as a subcommand and agent names after it", () => {
    const { host } = setup();
    const complete = host.commands.get("agents")?.complete;

    expect(complete?.("se")?.map((entry) => entry.value)).toEqual(["setup"]);
    expect(complete?.("setup sc")?.map((entry) => entry.value)).toEqual(["setup scout"]);
  });
});
