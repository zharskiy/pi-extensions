import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHostPiFiles } from "../../hostpi/index.ts";
import { tempDir, writeJson, writeText } from "./fixtures.ts";

describe("readHostPiFiles", () => {
  it("reads the four pi files and leaves absent ones undefined", async () => {
    const agentDir = await tempDir("host-files");

    await writeJson(join(agentDir, "auth.json"), { a: { type: "api_key", key: "k" } });

    await writeJson(join(agentDir, "settings.json"), { packages: [] });

    const files = await readHostPiFiles(agentDir);

    expect(files).toEqual({
      agentDir,
      auth: { a: { type: "api_key", key: "k" } },
      models: undefined,
      mcp: undefined,
      settings: { packages: [] },
      notices: [],
    });
  });

  it("turns invalid JSON into a notice that carries no file content", async () => {
    const agentDir = await tempDir("host-files");

    await writeText(join(agentDir, "models.json"), '{ "apiKey": "SECRET-IN-BROKEN-FILE"');

    await writeJson(join(agentDir, "mcp.json"), ["not", "an", "object"]);

    const files = await readHostPiFiles(agentDir);

    expect(files.models).toBeUndefined();
    expect(files.mcp).toBeUndefined();
    expect(files.notices).toEqual([
      `${join(agentDir, "models.json")}: invalid JSON, ignored`,
      `${join(agentDir, "mcp.json")}: not a JSON object, ignored`,
    ]);
    expect(JSON.stringify(files)).not.toContain("SECRET-IN-BROKEN-FILE");
  });
});
