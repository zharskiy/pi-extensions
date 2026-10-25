import { describe, expect, it } from "vitest";
import { char, key } from "../../../../../test/framework/index.ts";
import { initialSetup } from "../../../ui/agent-setup/form.ts";
import { context, PATHS, press, proposedContext, render } from "../../support/setup-context.ts";

const EVERY_PROJECT =
  " This project is not trusted, so pi does not read its .pi/pi-subagents.json; the user file applies to every project.";

describe("agent setup rendering", () => {
  it("renders the agent tab with its fields, tools note and MCP line", () => {
    const lines = render(context(), initialSetup(context()));

    expect(lines.slice(1, 3)).toEqual([" Leads   □ lead  □ helper", " Chores  □ chore  ✓ Submit"]);
    expect(lines).toContain(" lead Leads things.");
    expect(lines).toContain(" › Model     acme/big");
    expect(lines).toContain("   Thinking  high");
    expect(lines).toContain("   Skills    all (every skill of the agent's caller)");
    expect(lines).toContain("   Previous  acme/big · high · all (in use)");
    expect(lines.some((line) => line.includes("Suggested"))).toBe(false);
    expect(lines.some((line) => line.includes("create your own agent with /agents create."))).toBe(true);
    expect(lines.some((line) => line.startsWith(" MCP: on"))).toBe(true);
  });

  it("renders a chore tab with its skills as a fixed row after model and thinking", () => {
    const ctx = context();
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("tab"), key("tab")).state);

    expect(lines[2]).toBe(" Chores  □ chore  ✓ Submit");
    expect(lines.slice(lines.indexOf(" chore Does chores.") + 2).slice(0, 3)).toEqual([
      " › Model     gone/old",
      "   Thinking  default",
      "   Skills    none · fixed for chores",
    ]);
  });

  it("lists the changes and only the user file on the submit tab when untrusted, saying it applies everywhere", () => {
    const ctx = context(false);
    const edited = press(ctx, initialSetup(ctx), key("down"), key("enter"), key("home"), key("enter"));
    const lines = render(ctx, press(ctx, edited.state, key("left")).state);

    expect(lines).toContain(" Changes");
    expect(lines).toContain(" lead: thinking off (was high)");
    expect(lines).toContain(` › 1. User  ${PATHS.user}`);
    expect(lines).toContain(EVERY_PROJECT);
    expect(lines.some((line) => line.includes(PATHS.project))).toBe(false);
    expect(lines.some((line) => line.includes("enter to save"))).toBe(true);
  });

  it("shows no untrusted line and no project line in a plain trusted form", () => {
    const ctx = context();
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("left")).state);

    expect(lines).not.toContain(EVERY_PROJECT);
    expect(lines.some((line) => line.startsWith(" Project:"))).toBe(false);
    expect(lines.some((line) => line.startsWith(" Proposed:"))).toBe(false);
  });

  it("shows the reasons on a proposed agent's tab and the project kind on the submit tab", () => {
    const ctx = proposedContext();

    expect(render(ctx, initialSetup(ctx))).toContain(" Proposed: search finds code");
    expect(render(ctx, press(ctx, initialSetup(ctx), key("tab")).state)).not.toContain(
      " Proposed: search finds code",
    );
    expect(render(ctx, press(ctx, initialSetup(ctx), key("left")).state)).toContain(
      " Project: A TypeScript library",
    );
  });

  it("shows the filter under the picker title with a placeholder, a count and a no-match line", () => {
    const ctx = context();
    const opened = press(ctx, initialSetup(ctx), key("down"), key("down"), key("enter"));
    const lines = render(ctx, opened.state);
    const typed = (text: string) => render(ctx, press(ctx, opened.state, ...[...text].map(char)).state);

    expect(lines.slice(lines.indexOf(" Skills"), lines.indexOf(" Skills") + 3)).toEqual([
      " Skills",
      " / type to filter",
      " › [x] all  every skill of the agent's caller",
    ]);
    expect(lines.some((line) => line.includes("type to filter · ↑↓ to select · space to toggle"))).toBe(true);
    expect(typed("do")).toContain(" / do▏   1 of 2");
    expect(typed("zzq")).toContain(' no skill matches "zzq"');
    expect(typed("zzq").some((line) => line.includes("[ ]") || line.includes("[x]"))).toBe(false);
    expect(render(ctx, press(ctx, initialSetup(ctx), key("enter"), char("q")).state)).toContain(
      ' no model matches "q"',
    );
  });

  it("shows only the window of model options around the cursor", () => {
    const ctx = {
      ...context(),
      models: Array.from({ length: 20 }, (_, index) => ({
        ref: `acme/m${index}`,
        contextWindow: 100_000,
        cost: { input: 1, output: 2 },
        thinking: ["off"],
      })),
    };
    const lines = render(ctx, press(ctx, initialSetup(ctx), key("enter")).state);

    expect(lines).toContain("   inherit (the main session's model)");
    expect(lines.some((line) => line.includes("more"))).toBe(true);
    expect(lines.some((line) => line.includes("acme/m19"))).toBe(false);
  });
});
