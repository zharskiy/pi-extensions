import { describe, expect, it, vi } from "vitest";
import { createFakeHost } from "../../../test/framework/index.ts";
import { createContext, SNAPSHOT_ENTRY } from "../api/plugin.ts";
import { facts, STAMP } from "./support/context-snapshots.ts";

vi.mock("node:path", async () => {
  const path = await vi.importActual<typeof import("node:path")>("node:path");

  return { ...path.win32, default: path.win32 };
});

const memoryFile = (path: string) =>
  `<project_instructions path="${path}">\n${"x".repeat(400)}\n</project_instructions>`;

describe("/context on Windows paths", () => {
  it("shortens memory files under the cwd and the home folder with Windows separators", async () => {
    const host = createFakeHost({ cwd: "C:\\Users\\me\\work" });

    createContext(host, { home: "C:\\Users\\me", now: () => STAMP });
    host.facts = facts({
      sections: [
        {
          name: "project_context",
          text: `${memoryFile("C:\\Users\\me\\work\\AGENTS.md")}${memoryFile("C:\\Users\\me\\.pi\\agent\\AGENTS.md")}`,
        },
      ],
    });
    host.start();

    await host.runCommand("context");

    const lines = host.renderEntry(SNAPSHOT_ENTRY, host.entries[0]?.data, { width: 120, expanded: true });
    const memory = lines.filter((line) => line.includes("AGENTS.md:"));

    expect(memory.map((line) => line.trim().replace(/^↳ /, "").split(":")[0]).sort()).toEqual([
      "AGENTS.md",
      "~\\.pi\\agent\\AGENTS.md",
    ]);
  });
});
