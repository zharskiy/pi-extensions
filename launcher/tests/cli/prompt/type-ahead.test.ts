import { describe, expect, it } from "vitest";
import { KEY, plainPrompts, richPrompts, until } from "./fake-tty.ts";

const CHOICES = [
  { value: 1, label: "one" },
  { value: 2, label: "two" },
];

const pick = (prompts: ReturnType<typeof richPrompts>["prompts"], title: string) =>
  prompts.select({ title, choices: CHOICES, collapsed: () => undefined });

describe("keys typed ahead in one chunk", () => {
  it("reach the following rich prompts in order", async () => {
    const fake = richPrompts();
    const first = pick(fake.prompts, "First");

    await until(() => fake.screen.lines().includes("◆  First"));

    fake.input.write(`${KEY.enter}${KEY.down}${KEY.enter}${KEY.enter}`);

    expect(await first).toBe(1);
    expect(await pick(fake.prompts, "Second")).toBe(2);
    expect(await pick(fake.prompts, "Third")).toBe(1);
  });

  it("are dropped when a task runs between the prompts", async () => {
    const fake = richPrompts();
    const first = pick(fake.prompts, "First");

    await until(() => fake.screen.lines().includes("◆  First"));

    fake.input.write(`${KEY.enter}${KEY.down}${KEY.enter}`);

    expect(await first).toBe(1);

    await fake.prompts.task({ title: "", interruptWarning: "", run: async () => undefined });

    const second = pick(fake.prompts, "Second");

    await until(() => fake.screen.lines().includes("◆  Second"));

    fake.input.write(KEY.enter);

    expect(await second).toBe(1);
  });

  it("reach the following plain questions in order", async () => {
    const fake = plainPrompts();
    const first = pick(fake.prompts, "First");

    await until(() => fake.screen.lines().includes("Choose [1]:"));

    fake.input.write("1\n2\n1\n");

    expect(await first).toBe(1);
    expect(await pick(fake.prompts, "Second")).toBe(2);
    expect(await pick(fake.prompts, "Third")).toBe(1);
    expect(fake.screen.lines()).toContain("Choose [1]: 2");
  });
});
