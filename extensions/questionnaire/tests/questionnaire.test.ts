import { describe, expect, it } from "vitest";
import type { RunMode } from "../../../platform/pi-adapter/index.ts";
import { AWAITING_INPUT_CHANNEL } from "../../../platform/shared/index.ts";
import { char, createFakeHost, flushMicrotasks, key } from "../../../test/framework/index.ts";
import { createQuestionnaire } from "../api/plugin.ts";
import { QUESTIONNAIRE_SOURCE } from "../core/questionnaire.ts";
import type { QuestionnaireDetails, QuestionnaireParams } from "../core/questions.ts";
import { ANSWER_ARM_MS } from "../ui/view.ts";
import { PRIORITY, SCOPE } from "./support/questions.ts";

const setup = (mode: RunMode = "tui") => {
  const clock = { now: 1_000 };
  const host = createFakeHost({ mode });

  createQuestionnaire(host, () => clock.now);
  host.start();

  const tool = host.tool<QuestionnaireParams, QuestionnaireDetails>("questionnaire");

  return { host, tool, clock };
};

const run = (tool: ReturnType<typeof setup>["tool"], params: QuestionnaireParams, signal?: AbortSignal) =>
  tool.execute(params, { signal });

const waitingSignals = (host: ReturnType<typeof setup>["host"]) =>
  host.published.filter((entry) => entry.channel === AWAITING_INPUT_CHANNEL).map((entry) => entry.data);

describe("questionnaire tool", () => {
  it("declares itself as a sequential, model-only tool", () => {
    const { tool } = setup();

    expect(tool).toMatchObject({
      name: "questionnaire",
      executionMode: "sequential",
      modelOnly: true,
    });
  });

  it("returns an error outside the interactive terminal, without a form", async () => {
    const results = await Promise.all(
      (["rpc", "print", "json"] as const).map(async (mode) => {
        const { host, tool } = setup(mode);
        const result = await run(tool, { questions: [SCOPE] });

        return { isError: result.isError, text: result.text, forms: host.forms.length };
      }),
    );

    expect(results.every((result) => result.isError && result.forms === 0)).toBe(true);
    expect(results[0]?.text).toContain("needs the interactive terminal");
  });

  it("returns an error for an empty batch", async () => {
    const { host, tool } = setup();
    const result = await run(tool, { questions: [] });

    expect([result.isError, result.text, host.forms.length]).toEqual([
      true,
      "Error: No questions provided",
      0,
    ]);
  });

  it("submits a single question on Enter and reports the answer to the model", async () => {
    const { host, tool, clock } = setup();
    const pending = run(tool, { questions: [SCOPE] });

    await flushMicrotasks();
    clock.now += ANSWER_ARM_MS;
    host.form().press(key("down"), key("enter"));

    const result = await pending;

    expect(result.text).toBe("Scope (scope): selected 2. Backend only [value: backend]");
    expect(result.details?.cancelled).toBe(false);
    expect(host.form().closed).toBe(true);
  });

  it("ignores digits typed ahead in the first moments after the form opens", async () => {
    const { host, tool, clock } = setup();
    const pending = run(tool, { questions: [SCOPE] });

    await flushMicrotasks();
    host.form().press(char("1"));
    clock.now += ANSWER_ARM_MS - 1;
    host.form().press(char("1"));

    expect(host.form().closed).toBe(false);

    clock.now += 1;
    host.form().press(char("1"));

    expect((await pending).text).toBe("Scope (scope): selected 1. Frontend only [value: frontend]");
  });

  it("ignores Enter typed ahead in the first moments after the form opens", async () => {
    const { host, tool, clock } = setup();
    const pending = run(tool, { questions: [SCOPE] });

    await flushMicrotasks();
    host.form().press(key("enter"));
    clock.now += ANSWER_ARM_MS - 1;
    host.form().press(key("enter"));

    expect(host.form().closed).toBe(false);

    clock.now += 1;
    host.form().press(key("enter"));

    expect((await pending).text).toBe("Scope (scope): selected 1. Frontend only [value: frontend]");
  });

  it("walks several questions, takes a typed answer and submits from the Submit tab", async () => {
    const { host, tool, clock } = setup();
    const pending = run(tool, { questions: [SCOPE, PRIORITY] });

    await flushMicrotasks();
    clock.now += ANSWER_ARM_MS;

    const form = host.form();

    form.press(char("3"));
    form.type("both");

    expect(form.render(60)).toContain(" > both");

    form.press(key("enter"), char("2"));

    expect(form.render(60)).toContain(" Ready to submit");

    form.press(key("enter"));

    const result = await pending;

    expect(result.text).toBe(
      ["Scope (scope): wrote: both", "Priority (priority): selected 2. Later [value: later]"].join("\n"),
    );
    expect(host.renderTool("questionnaire", { result }).result).toBe(
      ["  ↳ Scope: both (wrote)", "    Priority: 2. Later"].join("\n"),
    );
  });

  it("puts the earlier typed answer back in the text input when the question is opened again", async () => {
    const { host, tool, clock } = setup();
    const pending = run(tool, { questions: [SCOPE, PRIORITY] });

    await flushMicrotasks();
    clock.now += ANSWER_ARM_MS;

    const form = host.form();

    form.press(char("3"));
    form.type("both");
    form.press(key("enter"), key("left"));

    expect(form.render(60)).not.toContain(" > both");

    form.press(char("3"));

    expect(form.render(60)).toContain(" > both");

    form.press(key("escape"), key("escape"));
    await pending;
  });

  it("Esc in the text input returns to the options, Esc there cancels with the answers so far", async () => {
    const { host, tool, clock } = setup();
    const pending = run(tool, { questions: [SCOPE, PRIORITY] });

    await flushMicrotasks();
    clock.now += ANSWER_ARM_MS;

    const form = host.form();

    form.press(char("1"), char("3"));

    expect(form.closed).toBe(false);

    form.press(key("backTab"), char("3"), key("escape"));

    expect(form.closed).toBe(false);

    form.press(key("escape"));

    const result = await pending;

    expect(result.details?.cancelled).toBe(true);
    expect(result.text).toBe(
      [
        "User cancelled the questionnaire",
        "Answered before cancelling:",
        "Scope (scope): selected 1. Frontend only [value: frontend]",
        "Pick a sensible default for anything unanswered, or stop.",
      ].join("\n"),
    );
  });

  it("reports a cancel with the partial answers when the signal aborts", async () => {
    const { host, tool, clock } = setup();
    const controller = new AbortController();
    const pending = run(tool, { questions: [SCOPE, PRIORITY] }, controller.signal);

    await flushMicrotasks();
    clock.now += ANSWER_ARM_MS;
    host.form().press(char("2"));
    controller.abort();

    const result = await pending;

    expect(result.details?.cancelled).toBe(true);
    expect(result.details?.answers.map((answer) => answer.value)).toEqual(["backend"]);
  });

  it("publishes waiting while the form is open", async () => {
    const { host, tool } = setup();
    const pending = run(tool, { questions: [SCOPE] });

    await flushMicrotasks();

    expect(waitingSignals(host)).toEqual([
      { source: QUESTIONNAIRE_SOURCE, waiting: true, title: "questionnaire" },
    ]);

    host.form().press(key("escape"));
    await pending;

    expect(waitingSignals(host)).toEqual([
      { source: QUESTIONNAIRE_SOURCE, waiting: true, title: "questionnaire" },
      { source: QUESTIONNAIRE_SOURCE, waiting: false, title: "questionnaire" },
    ]);
  });

  it.each([
    ["the overlay wait ends without a form", false],
    ["the signal aborts during the overlay wait", true],
  ])("publishes waiting before the form opens and stops it once when %s", async (_, aborts) => {
    const { host, tool } = setup();
    const controller = new AbortController();
    let release: (value: undefined) => void = () => {};

    host.ui.showForm = (_factory, options) =>
      new Promise((resolve) => {
        release = resolve;
        options?.signal?.addEventListener("abort", () => resolve(undefined));
      });

    const pending = run(tool, { questions: [SCOPE] }, controller.signal);

    await flushMicrotasks();

    expect(waitingSignals(host)).toEqual([
      { source: QUESTIONNAIRE_SOURCE, waiting: true, title: "questionnaire" },
    ]);

    if (aborts) {
      controller.abort();
    } else {
      release(undefined);
    }

    expect((await pending).details?.cancelled).toBe(true);
    expect(waitingSignals(host)).toEqual([
      { source: QUESTIONNAIRE_SOURCE, waiting: true, title: "questionnaire" },
      { source: QUESTIONNAIRE_SOURCE, waiting: false, title: "questionnaire" },
    ]);
  });

  it("renders the call", () => {
    const { host } = setup();

    expect(host.renderTool("questionnaire", { call: { questions: [SCOPE, PRIORITY] } }).call).toBe(
      "✓ questionnaire · 2 questions",
    );
  });
});
