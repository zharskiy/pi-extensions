import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";
import {
  FAKES,
  INSTALL_TIMEOUT_MS,
  installRoot,
  packageVersion,
  runInstall,
  SYSTEM_TOOLS,
} from "./install-harness.ts";

const API_1_CORPUS = [
  [],
  ["--cpu", "4", "--memory", "8", "--disk", "60"],
  ["--root", "$WORK"],
  ["--root", "$WORK", "--root", "$WORK/second"],
  ["--config", "$ORG"],
  ["--config", "$ORG", "--config-conflict", "keep"],
  ["--config", "$ORG", "--config-conflict", "replace"],
  ["--config", "$ORG", "--config-conflict", "fail"],
  ["--config", "$ORG", "--root", "$WORK"],
  ["--with-extensions"],
  ["--no-extensions"],
  ["--with-extensions", "--no-extensions"],
  ["--extensions-source", "npm:@zharskiy/pinata@0.4.0"],
  ["--extensions-source", "git:github.com/zharskiy/pi-extensions@v0.4.0"],
  ["--extensions-source", "https://github.com/zharskiy/pi-extensions.git"],
  ["--no-smoke"],
  ["--with-extensions", "--config", "$ORG", "--root", "$WORK", "--no-smoke", "--cpu", "2"],
];

const EXIT_CODES = [0, 64, 69, 70, 73, 75, 78, 79, 130, 143];

const RECEIPT_KEYS = [
  "bootstrap",
  "config",
  "extensions",
  "installedAt",
  "installerApi",
  "package",
  "pi",
  "schemaVersion",
  "smoke",
];

const corpusRoot = async (fakes: Record<string, string> = {}) => {
  const setup = await installRoot(fakes);
  const work = join(setup.root, "work");
  const org = join(setup.root, "org.json");

  await mkdir(join(work, "second"), { recursive: true });

  await writeFile(org, JSON.stringify({ env: { allow: ["CORP_REGION"] } }));

  return { ...setup, work, org };
};

describe("installer api 1", { timeout: INSTALL_TIMEOUT_MS * 4 }, () => {
  it("keeps accepting every invocation in the append-only corpus with --dry-run", async () => {
    const { root, work, org } = await corpusRoot();
    const results = API_1_CORPUS.map((flags) => {
      const args = flags.map((flag) => flag.replace("$WORK", work).replace("$ORG", org));
      const result = runInstall(root, [...args, "--dry-run"]);

      return { args: args.join(" "), status: result.status, stderr: result.stderr };
    });

    expect(results.filter((result) => result.status !== 0)).toEqual([]);
  });

  it("reports its api in --version", async () => {
    const { root } = await installRoot();

    expect(runInstall(root, ["--version"]).stdout).toBe(
      `@zharskiy/pinata ${await packageVersion()} (installer api 1)\n`,
    );
  });

  it("exits only with the codes of the documented table", async () => {
    const script = await readFile(join(launcherRoot(), "install.sh"), "utf8");
    const guide = await readFile(join(launcherRoot(), "..", "INSTALL.md"), "utf8");
    const used = [...script.matchAll(/(?:fail_with|exit) ([0-9]+)/g)].map((match) => Number(match[1]));
    const table = guide.split("### Exit codes")[1]?.split("\n#")[0] ?? "";
    const documented = [...table.matchAll(/^\| ([0-9]+) \|/gm)].map((match) => Number(match[1]));

    expect([...new Set(used)].filter((code) => !EXIT_CODES.includes(code))).toEqual([]);
    expect(documented).toEqual(EXIT_CODES);
  });

  it("never leaks a raw exit status when any tool it runs fails", async () => {
    const tools = [...SYSTEM_TOOLS, ...Object.keys(FAKES), "node"];
    const results = await Promise.all(
      tools.map(async (tool) => {
        const { root, work } = await corpusRoot({ [tool]: "exit 9" });
        const result = runInstall(root, ["--with-extensions", "--root", work]);

        return { tool, status: result.status, stderr: result.stderr };
      }),
    );

    expect(results.filter((result) => !EXIT_CODES.includes(result.status ?? -1))).toEqual([]);
    expect(
      results.filter((result) => result.status !== 0 && !/pi-sandbox install: /.test(result.stderr)),
    ).toEqual([]);
  });

  it("writes a receipt with the api 1 key set", async () => {
    const { root } = await installRoot();

    expect(runInstall(root, ["--no-smoke"]).status).toBe(0);

    const receipt = JSON.parse(await readFile(join(root, "state", "install.json"), "utf8")) as Record<
      string,
      unknown
    >;

    expect(Object.keys(receipt).sort()).toEqual(RECEIPT_KEYS);
    expect(receipt).toMatchObject({ schemaVersion: 1, installerApi: 1 });
    expect(Object.keys(receipt.package as object).sort()).toEqual(["mode", "name", "spec", "version"]);
  });
});
