import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  type Theme,
  ToolExecutionComponent,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolCallView, ToolRows } from "../../adapter/contract.ts";
import { applyToolRows, rowRenderers, toolRowsHost } from "../../adapter/pi-tool-rows.ts";
import type { PiToolRenderContext } from "../../adapter/pi-tools.ts";
import { initRenderTheme } from "./render-theme.ts";

beforeAll(() => {
  initRenderTheme();
});

const context = (patch: Partial<PiToolRenderContext> = {}) =>
  ({
    args: { path: "a.ts" },
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 1,
    ...patch,
  }) as PiToolRenderContext;

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

const views: ToolCallView[] = [];

const rows: ToolRows = (view) => {
  views.push(view);

  if (view.name === "skip") {
    return undefined;
  }

  return {
    call: (_width, theme) => [`● ${theme.bold(view.name)}`],
    result: () => [`  ⎿  done ${view.result?.text ?? ""}`.trimEnd()],
    piBody: true,
  };
};

const fakeTheme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_token: string, text: string) => text,
} as unknown as Theme;

const theme = () => fakeTheme;

const editResult = { content: [{ type: "text", text: "ok" }], details: { diff: "-1 old line\n+1 new line" } };

describe("rowRenderers", () => {
  afterEach(() => {
    views.length = 0;
  });

  it("returns a self-drawn base of another tool untouched and the base when the rows skip the tool", () => {
    const own: ToolRenderers = { renderShell: "self", renderCall: () => new Text("own", 0, 0) };
    const plainBase: ToolRenderers = { renderCall: () => new Text("base", 0, 0) };

    expect(rowRenderers(rows, "mine", own)).toBe(own);
    expect(rowRenderers(rows, "skip", plainBase)).toBe(plainBase);
    expect(rowRenderers(undefined, "read", plainBase)).toBe(plainBase);
  });

  it("restyles pi's built-in edit even though pi draws it in its own shell", () => {
    const base = createEditToolDefinition("/repo") as ToolRenderers;
    const renderers = rowRenderers(rows, "edit", base);

    expect(base.renderShell).toBe("self");
    expect(renderers).not.toBe(base);
    expect(renderers?.renderShell).toBe("self");
  });

  it("puts the row after pi's output pad", () => {
    const renderers = rowRenderers(rows, "read", createReadToolDefinition("/repo") as ToolRenderers);
    const padded = renderers?.renderCall?.({}, theme(), context({ outputPad: 1 })).render(40) ?? [];
    const flush = renderers?.renderCall?.({}, theme(), context({ outputPad: 0 })).render(40) ?? [];

    expect(plain(padded)).toEqual([" ● read"]);
    expect(plain(flush)).toEqual(["● read"]);
  });

  it("passes the call state and the result to the rows", () => {
    const renderers = rowRenderers(rows, "read", undefined);

    renderers?.renderResult?.(
      {
        content: [
          { type: "text", text: "body" },
          { type: "image", data: "x", mimeType: "image/png" },
        ],
      } as never,
      { expanded: true, isPartial: false },
      theme(),
      context({ isError: true, expanded: true, executionStarted: true }),
    );

    expect(views.at(-1)).toMatchObject({
      name: "read",
      args: { path: "a.ts" },
      started: true,
      isError: true,
      expanded: true,
      cwd: "/repo",
      result: { text: "body", images: 1 },
    });
  });

  it("shows pi's edit diff under the summary when expanded, and only the summary when collapsed", () => {
    const renderers = rowRenderers(rows, "edit", createEditToolDefinition("/repo") as ToolRenderers);
    const render = (expanded: boolean) =>
      plain(
        renderers
          ?.renderResult?.(
            editResult as never,
            { expanded, isPartial: false },
            theme(),
            context({ expanded }),
          )
          .render(60) ?? [],
      );

    expect(render(false)).toEqual(["   ⎿  done ok"]);

    const expanded = render(true);

    expect(expanded[0]).toBe("   ⎿  done ok");
    expect(expanded.slice(1).some((line) => line.includes("old line"))).toBe(true);
    expect(expanded.slice(1).some((line) => line.includes("new line"))).toBe(true);
    expect(expanded.slice(1).every((line) => line.startsWith("      "))).toBe(true);
  });

  it("reuses the component pi hands back", () => {
    const renderers = rowRenderers(rows, "read", undefined);
    const first = renderers?.renderCall?.({}, theme(), context());
    const second = renderers?.renderCall?.({}, theme(), context({ lastComponent: first }));

    expect(second).toBe(first);
  });
});

describe("toolRowsHost", () => {
  it("registers a resolver with pi and shares the rows with transcripts until it is released", () => {
    const resolvers: ToolRendererResolver[] = [];
    const api = {
      registerToolRenderer: (resolver: ToolRendererResolver) => {
        resolvers.push(resolver);
      },
    } as unknown as Pick<ExtensionAPI, "registerToolRenderer" | "getAllTools">;
    const host = toolRowsHost(api);

    host.registerToolRows(rows);

    expect(resolvers).toHaveLength(1);
    expect(resolvers[0]?.("read", () => undefined)?.renderShell).toBe("self");
    expect(applyToolRows("read", undefined)?.renderShell).toBe("self");

    host.release();

    expect(applyToolRows("read", undefined)).toBeUndefined();
  });

  it("keeps rows another adapter copy registered later", () => {
    const api = { registerToolRenderer: () => {} } as unknown as Pick<
      ExtensionAPI,
      "registerToolRenderer" | "getAllTools"
    >;
    const first = toolRowsHost(api);
    const second = toolRowsHost(api);

    first.registerToolRows(rows);
    second.registerToolRows(rows);
    first.release();

    expect(applyToolRows("read", undefined)?.renderShell).toBe("self");

    second.release();
  });
});

describe("rowRenderers for other tools", () => {
  it("keeps a non-built-in tool that renders itself on pi's default shell", () => {
    const own: ToolRenderers = { renderCall: () => new Text("own", 0, 0) };
    const result: ToolRenderers = { renderResult: () => new Text("own", 0, 0) };

    expect(rowRenderers(rows, "notes_search", own)).toBe(own);
    expect(rowRenderers(rows, "notes_search", result)).toBe(result);
    expect(rowRenderers(rows, "notes_search", undefined)?.renderShell).toBe("self");
    expect(rowRenderers(rows, "notes_search", { renderShell: "default" })?.renderShell).toBe("self");
  });
});

describe("rows for tools pi ships", () => {
  const own: ToolRenderers = {
    renderCall: () => new Text("own", 0, 0),
    renderResult: () => new Text("own", 0, 0),
  };

  const listed = (source: string) => () => [
    { name: "codemode", sourceInfo: { source, path: `${source}:codemode` } },
  ];

  const resolve = (getAllTools: () => unknown[]) => {
    const resolvers: ToolRendererResolver[] = [];
    const api = {
      registerToolRenderer: (resolver: ToolRendererResolver) => {
        resolvers.push(resolver);
      },
      getAllTools,
    } as unknown as Pick<ExtensionAPI, "registerToolRenderer" | "getAllTools">;
    const host = toolRowsHost(api);

    host.registerToolRows(rows);

    const renderers = resolvers[0]?.("codemode", () => own);

    host.release();

    return renderers;
  };

  it("draws a pi-shipped tool with its own renderer as a row", () => {
    expect(resolve(listed("builtin"))?.renderShell).toBe("self");
  });

  it("keeps the renderer of the same tool when a third-party extension registered it", () => {
    expect(resolve(listed("npm"))).toBe(own);
  });

  it("keeps the renderer when pi cannot list its tools", () => {
    expect(
      resolve(() => {
        throw new Error("not bound");
      }),
    ).toBe(own);
  });

  it("hangs pi's own result under the row when expanded", () => {
    const body: ToolRenderers = { renderResult: () => new Text("pi body", 0, 0) };
    const renderers = rowRenderers(rows, "codemode", body, () => true);
    const lines = plain(
      renderers
        ?.renderResult?.(
          { content: [{ type: "text", text: "ok" }] } as never,
          { expanded: true, isPartial: false },
          theme(),
          context({ expanded: true }),
        )
        .render(40) ?? [],
    );

    expect(lines).toEqual(["   ⎿  done ok", "      pi body"]);
  });
});

describe("rows through pi's tool component", () => {
  const stateRows: ToolRows = (view) => ({
    call: () => [
      `● ${view.name} ${view.started ? "" : "queued "}${view.isPartial ? "running" : view.isError ? "failed" : "done"}`,
    ],
    result: () => (view.expanded ? [] : [`  ⎿  ${view.result?.text.split("\n")[0] ?? ""}`]),
    piBody: true,
  });

  const component = () =>
    new ToolExecutionComponent(
      "bash",
      "call-1",
      { command: "ls" },
      { outputPad: 1 },
      rowRenderers(stateRows, "bash", createBashToolDefinition("/repo") as ToolRenderers) as never,
      { requestRender: () => {} } as never,
      "/repo",
    );

  const shown = (tool: ToolExecutionComponent) => plain(tool.render(60));

  it("follows a call from queued to running to failed", () => {
    initRenderTheme();

    const tool = component();

    expect(shown(tool)).toEqual(["", " ● bash queued running"]);

    tool.markExecutionStarted();

    expect(shown(tool)).toEqual(["", " ● bash running"]);

    tool.updateResult({ content: [{ type: "text", text: "half" }], isError: false } as never, true);

    expect(shown(tool)).toEqual(["", " ● bash running", "   ⎿  half"]);

    tool.updateResult({ content: [{ type: "text", text: "boom" }], isError: true } as never);

    expect(shown(tool)).toEqual(["", " ● bash failed", "   ⎿  boom"]);
  });

  it("toggles a row on a click and hangs pi's expanded body under the child glyph", () => {
    initRenderTheme();

    const tool = component();

    tool.markExecutionStarted();
    tool.updateResult({ content: [{ type: "text", text: "one\ntwo" }], isError: false } as never);

    const before = shown(tool);
    const result = tool.handleMouse?.({
      type: "click",
      button: "left",
      x: 4,
      y: 2,
      screenX: 4,
      screenY: 2,
      width: 60,
      height: before.length,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    });

    expect(before).toEqual(["", " ● bash done", "   ⎿  one"]);
    expect(result?.handled).toBe(true);
    expect(shown(tool)).toEqual(["", " ● bash done", "   ⎿  one", "      two"]);
  });
});
