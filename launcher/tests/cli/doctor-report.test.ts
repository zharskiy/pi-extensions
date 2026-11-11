import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { failed, type NamedCheck, passed, skipped, warned } from "../../cli/commands/doctor-checks.ts";
import { type ReportOptions, renderReport } from "../../cli/commands/doctor-report.ts";

const HOME = "/Users/you";

const PLAIN: ReportOptions = { verbose: false, color: false, home: HOME };

const named = (section: NamedCheck["section"], name: string, result: NamedCheck["result"]): NamedCheck => ({
  name,
  section,
  result,
});

const rule = (id: string, result: NamedCheck["result"]): NamedCheck => ({
  name: `rule ${id}`,
  section: "credentials",
  group: "rules",
  result,
});

const answered = (host: string) => passed(`https://${host}/ answered HTTP 200`);

const RULES = [
  rule("a", answered("a.test")),
  rule("b", failed("https://b.test/: 0", { reasons: ["refused"], hint: "fix b" })),
  rule("c", answered("c.test")),
];

describe("the doctor report", () => {
  it("collapses the passing rules into one line after the last rule, naming them others when one did not pass", () => {
    expect(renderReport([RULES[0], RULES[2]] as NamedCheck[], [], PLAIN)).toEqual([
      "credentials",
      "  ok    rules             2 credential hosts answered through the proxy (--verbose lists them)",
      "",
      "result: ok (2 ok)",
    ]);
    expect(renderReport(RULES, [], PLAIN)).toEqual([
      "credentials",
      "  fail  rule b            https://b.test/: 0",
      "        refused",
      "        hint: fix b",
      "  ok    rules             2 other credential hosts answered through the proxy (--verbose lists them)",
      "",
      "result: fail (1 failed, 2 ok)",
    ]);
  });

  it("names one passing rule in the singular and leaves the rules line out when none passes", () => {
    expect(renderReport([RULES[0] as NamedCheck], [], PLAIN)).toContain(
      "  ok    rules             1 credential host answered through the proxy (--verbose lists them)",
    );
    expect(
      renderReport([RULES[1] as NamedCheck], [], PLAIN).filter((line) => line.includes(" rules ")),
    ).toEqual([]);
  });

  it("lists every rule in order with --verbose and counts the same", () => {
    const lines = renderReport(RULES, [], { ...PLAIN, verbose: true });

    expect(lines.filter((line) => /^ {2}\S+ +rules? /.test(line))).toEqual([
      "  ok    rule a            https://a.test/ answered HTTP 200",
      "  fail  rule b            https://b.test/: 0",
      "  ok    rule c            https://c.test/ answered HTTP 200",
    ]);
    expect(lines.at(-1)).toBe(renderReport(RULES, [], PLAIN).at(-1));
  });

  it("says ok with warnings when nothing failed but something warned", () => {
    expect(
      renderReport([named("sandbox", "vm", passed("")), named("host", "x", warned("y"))], [], PLAIN).at(-1),
    ).toBe("result: ok with warnings (1 warning, 1 ok)");
  });

  it("leaves out empty sections and the notices without notices, and the result line of a partial report", () => {
    expect(renderReport([named("sandbox", "vm", passed(""))], [], { ...PLAIN, partial: true })).toEqual([
      "sandbox",
      "  ok    vm",
    ]);
    expect(renderReport([], ["a notice"], { ...PLAIN, partial: true })).toEqual(["notices", "  a notice"]);
  });

  it("shows the home as ~ only where a path starts and drops the hint to run the doctor", () => {
    const lines = renderReport(
      [
        named(
          "host",
          "sessions",
          passed(`${HOME}/a and ${HOME}2/b and /x${HOME}/c (${HOME}/d, at:${HOME}/e`),
        ),
        named(
          "network",
          "proxy",
          failed("the egress proxy could not start", { hint: "run pi sandbox doctor" }),
        ),
      ],
      [`see ${HOME}/notes`],
      PLAIN,
    );

    expect(lines).toEqual([
      "host",
      `  ok    sessions          ~/a and ${HOME}2/b and /x${HOME}/c (~/d, at:~/e`,
      "",
      "network",
      "  fail  proxy             the egress proxy could not start",
      "",
      "notices",
      "  see ~/notes",
      "",
      "result: fail (1 failed, 1 ok)",
    ]);
  });

  it("colours the words only, keeping the plain text and its alignment", () => {
    const checks = [
      named("sandbox", "vm size", warned("below the recommended size", { hint: "resize it" })),
      named("network", "parent proxy", skipped("no parent proxy configured")),
      named("credentials", "trust", failed("github.com: CERT_NOT_YET_VALID")),
    ];
    const coloured = renderReport(checks, ["a notice"], { ...PLAIN, color: true });

    expect(coloured.map(stripVTControlCharacters)).toEqual(renderReport(checks, ["a notice"], PLAIN));
    expect(coloured).toEqual([
      "\u001b[1msandbox\u001b[0m",
      "  \u001b[33mwarn\u001b[0m  vm size           below the recommended size",
      "        \u001b[36mhint:\u001b[0m resize it",
      "",
      "\u001b[1mnetwork\u001b[0m",
      "  \u001b[2mskip\u001b[0m  parent proxy      no parent proxy configured",
      "",
      "\u001b[1mcredentials\u001b[0m",
      "  \u001b[1;31mfail\u001b[0m  trust             github.com: CERT_NOT_YET_VALID",
      "",
      "\u001b[1mnotices\u001b[0m",
      "  \u001b[2ma notice\u001b[0m",
      "",
      "result: \u001b[1;31mfail\u001b[0m (1 failed, 1 warning, 1 skipped)",
    ]);
  });
});
