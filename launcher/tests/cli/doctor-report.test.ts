import { describe, expect, it } from "vitest";
import { failed, type NamedCheck, passed, skipped, warned } from "../../cli/commands/doctor-checks.ts";
import { type ReportOptions, renderReport } from "../../cli/commands/doctor-report.ts";
import { withoutColour } from "./harness.ts";

const HOME = "/Users/you";

const PLAIN: ReportOptions = { verbose: false, color: false, home: HOME };

const RESIZE =
  "colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false --cpu 8 --memory 10";

const CLOCK = {
  reasons: [
    "the sandbox VM's clock is behind the host's, so the proxy's certificate, dated by the host, is not valid there yet",
  ],
  hint: "restart the VM to reset its clock: run pi sandbox stop once no pi session runs, then pi sandbox doctor again",
};

const host = (name: string, result: NamedCheck["result"]): NamedCheck => ({ name, section: "host", result });

const sandbox = (name: string, result: NamedCheck["result"]): NamedCheck => ({
  name,
  section: "sandbox",
  result,
});

const network = (name: string, result: NamedCheck["result"]): NamedCheck => ({
  name,
  section: "network",
  result,
});

const sweep = (name: string, result: NamedCheck["result"]): NamedCheck => ({
  name,
  section: "leak sweep",
  result,
});

const credential = (name: string, result: NamedCheck["result"]): NamedCheck => ({
  name,
  section: "credentials",
  result,
});

const rule = (id: string, result: NamedCheck["result"]): NamedCheck => ({
  name: `rule ${id}`,
  section: "credentials",
  group: "rules",
  result,
});

const answered = (url: string, status: number) => passed(`${url} answered HTTP ${status}`);

const PASSING_RULES = [
  rule("derived:auth:example:key", answered("https://models.example.test/", 404)),
  rule("derived:gh:github.com:token", answered("https://github.com/", 200)),
  rule("derived:gh:ghe.corp.test:token", answered("https://ghe.corp.test/", 200)),
];

const SHARED = [
  sandbox("vm", passed("")),
  sandbox("image", passed("pi-sandbox-base:local sha256:3f1c9a0b2e4d")),
  sandbox("container", passed("")),
  sandbox("sync", passed("")),
  network("proxy", passed("pid 41872 port 51234")),
  network("proxy health", passed("/healthz answers")),
  sweep("credential sweep", passed("no credential in the environment, auth.json or mcp.json")),
  network("no-route", passed("no direct route to 1.1.1.1:443")),
  network("mcp", passed("pi mcp list connects to every enabled server")),
  sweep("mcp-auth sweep", passed("2 entries in mcp-auth.json, every token is a placeholder")),
  sweep("settings sweep", passed("no settings.json package carries a credential in its URL")),
  sandbox("sessions share", passed("writable at the host path")),
];

const GREEN: NamedCheck[] = [
  sandbox("vm shares", passed("the sandbox VM shares every path this repository needs")),
  ...SHARED.slice(0, 1),
  host("host side", passed("")),
  ...SHARED.slice(1),
  credential("trust", passed("the container trusts the proxy's certificate for models.example.test")),
  ...PASSING_RULES,
  sandbox("vm size", passed("profile pi-sandbox has 8 CPUs and 10 GiB")),
  host("host pi", passed(`pi 1.6.0, managed install ${HOME}/.pi/agent/bin/pi; the image follows it`)),
  host("provider hosts", passed("23 built-in providers with known hosts")),
  network("parent proxy", skipped("no parent proxy configured")),
  host("sessions", passed(`${HOME}/.pi/agent/sessions/--Users-you-code-my-app--/ (host pi lists them)`)),
  credential("mcp docs", passed("signed in on the host (expires in 2 h)")),
];

const MIXED: NamedCheck[] = [
  sandbox("vm shares", passed("the sandbox VM shares every path this repository needs")),
  ...SHARED.slice(0, 1),
  host("host side", passed("")),
  ...SHARED.slice(1),
  credential("trust", failed("github.com: CERT_NOT_YET_VALID", CLOCK)),
  rule("derived:auth:example:key", answered("https://models.example.test/", 404)),
  rule("derived:gh:github.com:token", failed("https://github.com/: CERT_NOT_YET_VALID", CLOCK)),
  rule("derived:gh:ghe.corp.test:token", answered("https://ghe.corp.test/", 200)),
  rule(
    "derived:models:custom:apiKey",
    failed("https://llm.corp.test/: the sandbox proxy refused it", {
      reasons: [
        "llm.corp.test resolves only to restricted addresses (10.1.2.3 is a private network address)",
      ],
      hint: `add llm.corp.test to egress.privateHosts in ${HOME}/.pi/agent/pi-sandbox/config.json`,
    }),
  ),
  sandbox(
    "vm size",
    warned("profile pi-sandbox has 2 CPUs and 4 GiB, below 8 CPUs and 10 GiB", {
      hint: `resize it with ${RESIZE}`,
    }),
  ),
  host(
    "host pi",
    failed(`no managed pi in ${HOME}/.pi/agent`, {
      reasons: [
        "a pi installed with npm or found on PATH is not used",
        "the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable",
      ],
      hint: "install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) and run the launcher's install.sh again",
    }),
  ),
  host("provider hosts", failed("no host pi to read the provider host table with")),
  network("parent proxy", skipped("no parent proxy configured")),
  host("sessions", passed(`${HOME}/.pi/agent/sessions/--Users-you-code-my-app--/ (host pi lists them)`)),
];

const NOTICE =
  "node_modules overlaid in 1 directory; the host copies are hidden; set mounts.autoOverlays=false to keep them";

const plainOf = (lines: string[]) => lines.map(withoutColour);

describe("the doctor report", () => {
  it("renders an all-green run by area with the passing rules collapsed", () => {
    expect(renderReport(GREEN, [], PLAIN)).toEqual([
      "host",
      "  ok    host pi           pi 1.6.0, managed install ~/.pi/agent/bin/pi; the image follows it",
      "  ok    provider hosts    23 built-in providers with known hosts",
      "  ok    sessions          ~/.pi/agent/sessions/--Users-you-code-my-app--/ (host pi lists them)",
      "  ok    host side",
      "",
      "sandbox",
      "  ok    vm shares         the sandbox VM shares every path this repository needs",
      "  ok    vm",
      "  ok    vm size           profile pi-sandbox has 8 CPUs and 10 GiB",
      "  ok    image             pi-sandbox-base:local sha256:3f1c9a0b2e4d",
      "  ok    container",
      "  ok    sync",
      "  ok    sessions share    writable at the host path",
      "",
      "network",
      "  ok    proxy             pid 41872 port 51234",
      "  ok    proxy health      /healthz answers",
      "  skip  parent proxy      no parent proxy configured",
      "  ok    no-route          no direct route to 1.1.1.1:443",
      "  ok    mcp               pi mcp list connects to every enabled server",
      "",
      "credentials",
      "  ok    trust             the container trusts the proxy's certificate for models.example.test",
      "  ok    rules             3 credential hosts answered through the proxy (--verbose lists them)",
      "  ok    mcp docs          signed in on the host (expires in 2 h)",
      "",
      "leak sweep",
      "  ok    credential sweep  no credential in the environment, auth.json or mcp.json",
      "  ok    mcp-auth sweep    2 entries in mcp-auth.json, every token is a placeholder",
      "  ok    settings sweep    no settings.json package carries a credential in its URL",
      "",
      "result: ok (23 ok, 1 skipped)",
    ]);
  });

  it("renders a mixed run with reasons and hints under each problem, failing rules first, and the notices", () => {
    expect(renderReport(MIXED, [NOTICE], PLAIN)).toEqual([
      "host",
      "  fail  host pi           no managed pi in ~/.pi/agent",
      "        a pi installed with npm or found on PATH is not used",
      "        the sandbox gets no provider credentials, and host commands and --no-sandbox are unavailable",
      "        hint: install pi with pi's own installer (curl -fsSL https://pi.dev/install.sh | sh) and run the launcher's install.sh again",
      "  fail  provider hosts    no host pi to read the provider host table with",
      "  ok    sessions          ~/.pi/agent/sessions/--Users-you-code-my-app--/ (host pi lists them)",
      "  ok    host side",
      "",
      "sandbox",
      "  ok    vm shares         the sandbox VM shares every path this repository needs",
      "  ok    vm",
      "  warn  vm size           profile pi-sandbox has 2 CPUs and 4 GiB, below 8 CPUs and 10 GiB",
      `        hint: resize it with ${RESIZE}`,
      "  ok    image             pi-sandbox-base:local sha256:3f1c9a0b2e4d",
      "  ok    container",
      "  ok    sync",
      "  ok    sessions share    writable at the host path",
      "",
      "network",
      "  ok    proxy             pid 41872 port 51234",
      "  ok    proxy health      /healthz answers",
      "  skip  parent proxy      no parent proxy configured",
      "  ok    no-route          no direct route to 1.1.1.1:443",
      "  ok    mcp               pi mcp list connects to every enabled server",
      "",
      "credentials",
      "  fail  trust             github.com: CERT_NOT_YET_VALID",
      `        ${CLOCK.reasons[0]}`,
      `        hint: ${CLOCK.hint}`,
      "  fail  rule derived:gh:github.com:token  https://github.com/: CERT_NOT_YET_VALID",
      `        ${CLOCK.reasons[0]}`,
      `        hint: ${CLOCK.hint}`,
      "  fail  rule derived:models:custom:apiKey  https://llm.corp.test/: the sandbox proxy refused it",
      "        llm.corp.test resolves only to restricted addresses (10.1.2.3 is a private network address)",
      "        hint: add llm.corp.test to egress.privateHosts in ~/.pi/agent/pi-sandbox/config.json",
      "  ok    rules             2 other credential hosts answered through the proxy (--verbose lists them)",
      "",
      "leak sweep",
      "  ok    credential sweep  no credential in the environment, auth.json or mcp.json",
      "  ok    mcp-auth sweep    2 entries in mcp-auth.json, every token is a placeholder",
      "  ok    settings sweep    no settings.json package carries a credential in its URL",
      "",
      "notices",
      `  ${NOTICE}`,
      "",
      "result: fail (5 failed, 1 warning, 17 ok, 1 skipped)",
    ]);
  });

  it("lists every rule in pipeline order with --verbose and counts the same", () => {
    const lines = renderReport(MIXED, [], { ...PLAIN, verbose: true });

    expect(lines.filter((line) => /^ {2}\S+ +rules? /.test(line))).toEqual([
      "  ok    rule derived:auth:example:key  https://models.example.test/ answered HTTP 404",
      "  fail  rule derived:gh:github.com:token  https://github.com/: CERT_NOT_YET_VALID",
      "  ok    rule derived:gh:ghe.corp.test:token  https://ghe.corp.test/ answered HTTP 200",
      "  fail  rule derived:models:custom:apiKey  https://llm.corp.test/: the sandbox proxy refused it",
    ]);
    expect(lines.at(-1)).toBe(renderReport(MIXED, [], PLAIN).at(-1));
  });

  it("names one passing rule in the singular and leaves the rules line out when none passes", () => {
    const one = renderReport([PASSING_RULES[0] as NamedCheck], [], PLAIN);
    const none = renderReport([rule("derived:x", failed("https://x.test/: 0"))], [], PLAIN);

    expect(one).toContain(
      "  ok    rules             1 credential host answered through the proxy (--verbose lists them)",
    );
    expect(none.filter((line) => line.includes(" rules "))).toEqual([]);
    expect(none.at(-1)).toBe("result: fail (1 failed)");
  });

  it("says ok with warnings when nothing failed but something warned", () => {
    expect(renderReport([sandbox("vm", passed("")), host("x", warned("y"))], [], PLAIN).at(-1)).toBe(
      "result: ok with warnings (1 warning, 1 ok)",
    );
    expect(
      renderReport([sandbox("vm", passed("")), host("x", warned("y")), host("z", warned("w"))], [], PLAIN).at(
        -1,
      ),
    ).toBe("result: ok with warnings (2 warnings, 1 ok)");
  });

  it("leaves out empty sections and the notices without notices, and the result line of a partial report", () => {
    expect(renderReport([sandbox("vm", passed(""))], [], { ...PLAIN, partial: true })).toEqual([
      "sandbox",
      "  ok    vm",
    ]);
    expect(renderReport([], ["a notice"], { ...PLAIN, partial: true })).toEqual(["notices", "  a notice"]);
  });

  it("shows only the home folder itself as ~ and drops the hint to run the doctor", () => {
    const lines = renderReport(
      [
        host("sessions", passed(`${HOME}/a and ${HOME}2/b and /x${HOME}/c (${HOME}/d, at:${HOME}/e`)),
        network("proxy", failed("the egress proxy could not start", { hint: "run pi sandbox doctor" })),
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
    const coloured = renderReport(MIXED, [NOTICE], { ...PLAIN, color: true });

    expect(plainOf(coloured)).toEqual(renderReport(MIXED, [NOTICE], PLAIN));
    expect(coloured).toContain("\u001b[1mcredentials\u001b[0m");
    expect(coloured).toContain(
      "  \u001b[1;31mfail\u001b[0m  trust             github.com: CERT_NOT_YET_VALID",
    );
    expect(coloured).toContain(
      "  \u001b[33mwarn\u001b[0m  vm size           profile pi-sandbox has 2 CPUs and 4 GiB, below 8 CPUs and 10 GiB",
    );
    expect(coloured).toContain("  \u001b[2mskip\u001b[0m  parent proxy      no parent proxy configured");
    expect(coloured).toContain(`        \u001b[36mhint:\u001b[0m resize it with ${RESIZE}`);
    expect(coloured).toContain(`  \u001b[2m${NOTICE}\u001b[0m`);
    expect(coloured.at(-1)).toBe("result: \u001b[1;31mfail\u001b[0m (5 failed, 1 warning, 17 ok, 1 skipped)");
  });
});
