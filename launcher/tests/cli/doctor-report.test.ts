import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { failed, type NamedCheck, passed, skipped, warned } from "../../cli/commands/doctor-checks.ts";
import { type ReportOptions, renderReport } from "../../cli/commands/doctor-report.ts";

const HOME = "/Users/you";

const PLAIN: ReportOptions = { verbose: false, color: false, unicode: false, home: HOME };

const VERBOSE: ReportOptions = { ...PLAIN, verbose: true };

const named = (section: NamedCheck["section"], name: string, result: NamedCheck["result"]): NamedCheck => ({
  name,
  section,
  result,
});

const rule = (label: string, id: string, result: NamedCheck["result"], login = true): NamedCheck => ({
  name: label,
  section: "credentials",
  group: "rules",
  note: `rule ${id}`,
  login,
  result,
});

const answered = (host: string) => passed(`https://${host}/ answered HTTP 200`);

const RULES = [
  rule("a login", "derived:auth:a:key", answered("a.test")),
  rule(
    "b login",
    "derived:auth:b:key",
    failed("https://b.test/: 0", { reasons: ["refused"], hint: "fix b" }),
  ),
  rule("c login", "derived:auth:c:key", answered("c.test")),
];

const HEALTHY: NamedCheck[] = [
  named("host", "pi", passed("1.6.0 at /Users/you/.pi/agent/bin/pi; the sandbox runs the same version")),
  named("host", "provider hosts", passed("43 built-in providers with known hosts")),
  named(
    "host",
    "sessions",
    passed("/Users/you/.pi/agent/sessions/--repo-- (host pi lists them)", {
      brief: "saved on the host in /Users/you/.pi/agent/sessions/--repo--",
    }),
  ),
  named("host", "host side", passed("")),
  named(
    "sandbox",
    "vm shares",
    passed("the sandbox VM shares exactly the workspaceRoot, the session dir and pinata's vm dir", {
      brief: "shares the workspace root",
    }),
  ),
  named("sandbox", "vm", passed("")),
  named("sandbox", "vm size", passed("profile pinata has 8 CPUs and 8 GiB", { brief: "8 CPUs, 8 GiB" })),
  named("sandbox", "file cache", passed("1109 open files, released at 30720")),
  named("sandbox", "image", passed("pinata-base:local sha256:abc", { brief: "pinata-base:local" })),
  named("sandbox", "container", passed("")),
  named("sandbox", "sync", passed("")),
  named(
    "sandbox",
    "sessions share",
    passed("writable at the host path", { brief: "writable from the sandbox" }),
  ),
  named("network", "proxy", passed("pid 1 port 2")),
  named("network", "proxy health", passed("the proxy answers its health check")),
  named("network", "parent proxy", skipped("no parent proxy configured", { neutral: true })),
  named("network", "isolation", passed("no direct route to the internet (tried 1.1.1.1:443)")),
  named("network", "tls inspection", passed("not inspected", { brief: "not inspected" })),
  named("network", "tls in sandbox", passed("the container trusts TLS to pi.dev through the sandbox proxy")),
  named("network", "mcp", passed("pi mcp list connects to every enabled server")),
  named("credentials", "trust", passed("the container trusts the proxy's certificate for a.test")),
  rule("a login", "derived:auth:a:key", answered("a.test")),
  named("leak sweep", "credential sweep", passed("no credential in the environment, auth.json or mcp.json")),
  named("leak sweep", "mcp-auth sweep", passed("no mcp-auth.json in the sandbox yet")),
  named("leak sweep", "settings sweep", passed("no settings.json package carries a credential in its URL")),
];

const replaced = (checks: NamedCheck[], name: string, result: NamedCheck["result"]) =>
  checks.map((check) => (check.name === name ? { ...check, result } : check));

describe("the doctor report", () => {
  it("merges each healthy group into one line and hides the checks that are quiet when ok", () => {
    expect(renderReport(HEALTHY, [], PLAIN)).toEqual([
      "Host",
      "  ok pi                1.6.0 at ~/.pi/agent/bin/pi; the sandbox runs the same version",
      "  ok sessions          saved on the host in ~/.pi/agent/sessions/--repo--, writable from the sandbox",
      "",
      "Sandbox",
      "  ok vm                running, 8 CPUs, 8 GiB, shares the workspace root",
      "  ok sandbox           starts here (pinata-base:local)",
      "",
      "Network",
      "  ok isolation         no direct route to the internet (tried 1.1.1.1:443)",
      "  ok tls               not inspected; the sandbox trusts HTTPS through the proxy",
      "",
      "Credentials",
      "  ok logins            1 login answered through the proxy (--verbose lists them)",
      "  ok secrets           no real credential inside the sandbox",
      "",
      "All checks passed.",
    ]);
  });

  it("lists every check with its detail and the rule id with --verbose, under the same result", () => {
    const lines = renderReport(HEALTHY, [], VERBOSE);

    expect(lines.filter((line) => line.startsWith("  "))).toHaveLength(HEALTHY.length);
    expect(lines).toContain("  ok image             pinata-base:local sha256:abc");
    expect(lines).toContain("  -  parent proxy      no parent proxy configured");
    expect(lines).toContain(
      "  ok a login           https://a.test/ answered HTTP 200 (rule derived:auth:a:key)",
    );
    expect(lines).toContain("Leak sweep");
    expect(lines.at(-1)).toBe("All checks passed.");
  });

  it("prints only the member that is not ok when one member of a group fails, under the same name in both views", () => {
    const broken = replaced(
      HEALTHY,
      "tls in sandbox",
      failed("the container does not trust TLS to pi.dev", { hint: "rebuild the image" }),
    );
    const failing = [
      "  x  tls in sandbox    the container does not trust TLS to pi.dev",
      "     -> rebuild the image",
    ];
    const plain = renderReport(broken, [], PLAIN);

    expect(plain.slice(plain.indexOf("Network"), plain.indexOf("Credentials"))).toEqual([
      "Network",
      "  ok isolation         no direct route to the internet (tried 1.1.1.1:443)",
      ...failing,
      "",
    ]);
    expect(renderReport(broken, [], VERBOSE).join("\n")).toContain(failing.join("\n"));
    expect(plain.at(-1)).toBe("1 check failed (tls in sandbox).");
  });

  it("shows a check that is quiet when ok once it warns or fails, and a parent proxy that is configured", () => {
    const troubled = replaced(
      replaced(
        replaced(HEALTHY, "proxy health", failed("the proxy does not answer its health check")),
        "file cache",
        warned("29000 open files, released at 30720"),
      ),
      "parent proxy",
      passed("proxy.corp.test:8080 answers"),
    );
    const lines = renderReport(troubled, [], PLAIN);

    expect(lines).toContain("  !  file cache        29000 open files, released at 30720");
    expect(lines).toContain("  x  proxy health      the proxy does not answer its health check");
    expect(lines).toContain("  ok parent proxy      proxy.corp.test:8080 answers");
    expect(lines.some((line) => line.includes(" provider hosts "))).toBe(false);
    expect(lines.at(-1)).toBe("1 check failed (proxy health) and 1 warned (file cache).");
  });

  it("prints a neutral skip of a group member in plain words, and keeps a skip that is not neutral", () => {
    const inVolume = replaced(
      HEALTHY,
      "sessions",
      skipped(
        "kept inside the sandbox, not on the host, so pi on the host does not list them (sessions.off)",
      ),
    );
    const unsized = replaced(
      HEALTHY,
      "vm size",
      skipped("colima did not report the size of profile pinata", { neutral: true }),
    );

    expect(renderReport(inVolume, [], PLAIN)).toContain(
      "  -  sessions          kept inside the sandbox, not on the host, so pi on the host does not list them (sessions.off)",
    );
    expect(renderReport(unsized, [], PLAIN)).toContain(
      "  ok vm                running, shares the workspace root",
    );
  });

  it("never loses a reason on an ok check: the merged line carries it, and an unmerged group prints its ok member", () => {
    const reasons = ["workspaceRoot: /x/gone is missing, so it is not shared until it exists"];
    const noted = replaced(
      HEALTHY,
      "vm shares",
      passed("the sandbox VM shares exactly the workspaceRoot, the session dir and pinata's vm dir", {
        brief: "shares the workspace root",
        reasons,
      }),
    );
    const merged = renderReport(noted, [], PLAIN);
    const unmerged = renderReport(replaced(noted, "vm size", warned("small")), [], PLAIN);

    expect(merged).toContain("  ok vm                running, 8 CPUs, 8 GiB, shares the workspace root");
    expect(merged).toContain(`     ${reasons[0]}`);
    expect(unmerged.slice(unmerged.indexOf("Sandbox"), unmerged.indexOf("Network"))).toEqual([
      "Sandbox",
      "  ok vm shares         the sandbox VM shares exactly the workspaceRoot, the session dir and pinata's vm dir",
      `     ${reasons[0]}`,
      "  ok sandbox           starts here (pinata-base:local)",
      "  !  vm size           small",
      "",
    ]);
  });

  it("names the image the sandbox starts from only when its reference is known", () => {
    const unnamed = (brief?: string) =>
      renderReport(
        replaced(HEALTHY, "image", passed(" sha256:abc", brief === undefined ? {} : { brief })),
        [],
        PLAIN,
      );

    expect(unnamed()).toContain("  ok sandbox           starts here (its image)");
    expect(unnamed("")).toContain("  ok sandbox           starts here (its image)");
  });

  it("counts a passing rule named for a host such as proxy or mcp, instead of hiding it like those checks", () => {
    const hosts = [
      rule("proxy", "corp-proxy", answered("proxy"), false),
      rule("mcp", "corp-mcp", answered("mcp"), false),
    ];

    expect(renderReport(hosts, [], PLAIN)).toEqual([
      "Credentials",
      "  ok credential hosts  2 credential rules answered through the proxy (--verbose lists them)",
      "",
      "All checks passed.",
    ]);
  });

  it("names the failed and warned checks on the result line, and drops the counts of the rest", () => {
    const checks = [
      named("network", "isolation", failed("the sandbox reaches 1.1.1.1:443 directly, outside the proxy")),
      named("network", "tls in sandbox", failed("not trusted")),
      named("sandbox", "vm size", warned("below the recommended size")),
      named("sandbox", "file cache", warned("close to the limit")),
      named("sandbox", "vm", passed("")),
    ];

    expect(renderReport(checks, [], PLAIN).at(-1)).toBe(
      "2 checks failed (isolation, tls in sandbox) and 2 warned (vm size, file cache).",
    );
    expect(
      renderReport([named("sandbox", "vm", passed("")), named("host", "x", warned("y"))], [], PLAIN).at(-1),
    ).toBe("No check failed, 1 warned (x).");
  });

  it("pads the name column to the longest printed name, with at least 16", () => {
    const long = rule(
      "a-very-long-provider-name login",
      "derived:auth:long:key",
      warned("missing or expired"),
    );

    expect(renderReport([long, named("sandbox", "vm size", warned("small"))], [], PLAIN)).toEqual([
      "Sandbox",
      "  !  vm size                          small",
      "",
      "Credentials",
      "  !  a-very-long-provider-name login  missing or expired",
      "",
      "No check failed, 2 warned (vm size, a-very-long-provider-name login).",
    ]);
    expect(renderReport([named("sandbox", "vm size", warned("small"))], [], PLAIN)).toContain(
      "  !  vm size           small",
    );
  });

  it("collapses the passing rules into one line after the last rule, naming them others when one did not pass", () => {
    expect(renderReport([RULES[0], RULES[2]] as NamedCheck[], [], PLAIN)).toEqual([
      "Credentials",
      "  ok logins            2 logins answered through the proxy (--verbose lists them)",
      "",
      "All checks passed.",
    ]);
    expect(renderReport(RULES, [], PLAIN)).toEqual([
      "Credentials",
      "  x  b login           https://b.test/: 0",
      "     refused",
      "     -> fix b",
      "  ok logins            2 other logins answered through the proxy (--verbose lists them)",
      "",
      "1 check failed (b login).",
    ]);
  });

  it("calls the collapsed rules credential hosts when one of them is not a login, and leaves it out when none passes", () => {
    const key = rule("models.example.test", "env:KEY", answered("models.example.test"), false);

    expect(renderReport([RULES[0] as NamedCheck, key], [], PLAIN)).toContain(
      "  ok credential hosts  2 credential rules answered through the proxy (--verbose lists them)",
    );
    expect(renderReport([RULES[0] as NamedCheck], [], PLAIN)).toContain(
      "  ok logins            1 login answered through the proxy (--verbose lists them)",
    );
    expect(renderReport([RULES[1] as NamedCheck], [], PLAIN).some((line) => line.includes(" logins "))).toBe(
      false,
    );
  });

  it("shows the rule id of a failing rule only when the rule comes from the config", () => {
    const configured: NamedCheck = {
      ...rule("models.example.test", "models", failed("https://models.example.test/: 0"), false),
      configured: true,
    };

    expect(renderReport([configured, RULES[1] as NamedCheck], [], PLAIN)).toEqual([
      "Credentials",
      "  x  models.example.test  https://models.example.test/: 0 (rule models)",
      "  x  b login              https://b.test/: 0",
      "     refused",
      "     -> fix b",
      "",
      "2 checks failed (models.example.test, b login).",
    ]);
  });

  it("lists every rule in order with --verbose and keeps the same result line", () => {
    const lines = renderReport(RULES, [], VERBOSE);

    expect(lines.filter((line) => / login /.test(line))).toEqual([
      "  ok a login           https://a.test/ answered HTTP 200 (rule derived:auth:a:key)",
      "  x  b login           https://b.test/: 0 (rule derived:auth:b:key)",
      "  ok c login           https://c.test/ answered HTTP 200 (rule derived:auth:c:key)",
    ]);
    expect(lines.at(-1)).toBe(renderReport(RULES, [], PLAIN).at(-1));
  });

  it("leaves out empty sections and the notices without notices, and the result line of a partial report", () => {
    expect(renderReport([named("sandbox", "vm", passed(""))], [], { ...VERBOSE, partial: true })).toEqual([
      "Sandbox",
      "  ok vm",
    ]);
    expect(renderReport([named("host", "host side", passed(""))], [], { ...PLAIN, partial: true })).toEqual(
      [],
    );
    expect(renderReport([], ["a notice"], { ...PLAIN, partial: true })).toEqual(["Notices", "  a notice"]);
  });

  it("shows the home as ~ only where a path starts and drops the hint to run the doctor", () => {
    const lines = renderReport(
      [
        named("host", "pi", passed(`${HOME}/a and ${HOME}2/b and /x${HOME}/c (${HOME}/d, at:${HOME}/e`)),
        named("network", "proxy", failed("the egress proxy could not start", { hint: "run pinata doctor" })),
      ],
      [`see ${HOME}/notes`],
      PLAIN,
    );

    expect(lines).toEqual([
      "Host",
      `  ok pi                ~/a and ${HOME}2/b and /x${HOME}/c (~/d, at:~/e`,
      "",
      "Network",
      "  x  proxy             the egress proxy could not start",
      "",
      "Notices",
      "  see ~/notes",
      "",
      "1 check failed (proxy).",
    ]);
  });

  it("prints each line of a hint as its own hint line, with the home shortened, and ranks the tls checks after the parent proxy", () => {
    const lines = renderReport(
      [
        named("network", "tls in sandbox", passed("the container trusts it")),
        named(
          "network",
          "tls inspection",
          failed("not trusted", { hint: `add it in ${HOME}/config.json\nor use a PEM file` }),
        ),
        named("network", "parent proxy", skipped("no parent proxy configured", { neutral: true })),
      ],
      [],
      VERBOSE,
    );

    expect(lines).toEqual([
      "Network",
      "  -  parent proxy      no parent proxy configured",
      "  x  tls inspection    not trusted",
      "     -> add it in ~/config.json",
      "     -> or use a PEM file",
      "  ok tls in sandbox    the container trusts it",
      "",
      "1 check failed (tls inspection).",
    ]);
  });

  it("prints the glyph marks where the terminal shows them, aligned like the ASCII ones", () => {
    const checks = [
      named("sandbox", "vm size", warned("below the recommended size", { hint: "resize it" })),
      named("network", "parent proxy", skipped("no parent proxy configured", { neutral: true })),
      named("credentials", "trust", failed("github.com: CERT_NOT_YET_VALID")),
      named("credentials", "secrets", passed("no real credential inside the sandbox")),
    ];

    expect(renderReport(checks, [], { ...VERBOSE, unicode: true })).toEqual([
      "Sandbox",
      "  ▲ vm size           below the recommended size",
      "    → resize it",
      "",
      "Network",
      "  - parent proxy      no parent proxy configured",
      "",
      "Credentials",
      "  ✖ trust             github.com: CERT_NOT_YET_VALID",
      "  ✔ secrets           no real credential inside the sandbox",
      "",
      "1 check failed (trust) and 1 warned (vm size).",
    ]);
  });

  it("colours the marks and the notices only, keeping the plain text and its alignment", () => {
    const checks = [
      named("sandbox", "vm size", warned("below the recommended size", { hint: "resize it" })),
      named("network", "parent proxy", skipped("no parent proxy configured", { neutral: true })),
      named("credentials", "trust", failed("github.com: CERT_NOT_YET_VALID")),
    ];
    const options = { ...VERBOSE, color: true };
    const coloured = renderReport(checks, ["a notice"], options);

    expect(coloured.map(stripVTControlCharacters)).toEqual(renderReport(checks, ["a notice"], VERBOSE));
    expect(coloured).toEqual([
      "Sandbox",
      "  \u001b[33m!\u001b[39m  vm size           below the recommended size",
      "     -> resize it",
      "",
      "Network",
      "  \u001b[2m-\u001b[22m  parent proxy      no parent proxy configured",
      "",
      "Credentials",
      "  \u001b[31mx\u001b[39m  trust             github.com: CERT_NOT_YET_VALID",
      "",
      "Notices",
      "  \u001b[2ma notice\u001b[22m",
      "",
      "1 check failed (trust) and 1 warned (vm size).",
    ]);
  });
});
