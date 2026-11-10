import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpSignIns } from "../../hostpi/index.ts";
import { mcpAuthKey } from "../../shared/index.ts";
import { tempDir, writeJson } from "./fixtures.ts";

describe("mcpSignIns", () => {
  it("lists the OAuth servers with their stored entry, skipping credential headers, disabled and provider servers", async () => {
    const agentDir = await tempDir("mcp-auth");
    const url = "https://plain.example/mcp";

    await writeJson(join(agentDir, "mcp-auth.json"), {
      [mcpAuthKey("plain", url)]: { access: "a", expiresAt: 1 },
    });

    const files = {
      agentDir,
      mcp: {
        mcpServers: {
          keyed: { url: "https://keyed.example/mcp", headers: { "X-Api-Key": "x" } },
          "dotted.name": { url: "https://dotted.example/mcp" },
          off: { url: "https://off.example/mcp", enabled: false },
          prov: { url: "https://prov.example/mcp", auth: { provider: "p" } },
          local: { url: "http://intranet.example/mcp" },
          tool: { command: "npx" },
          plain: { url },
          bare: { url: "https://bare.example/mcp" },
        },
      },
    };
    const servers = await mcpSignIns(files);

    expect(servers.map((server) => server.name)).toEqual(["plain", "bare"]);
    expect(servers[0]?.entry).toBeDefined();
    expect(servers[1]?.entry).toBeUndefined();
  });
});
