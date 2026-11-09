import type { EgressPreset, SandboxConfig } from "./types.ts";

export const EGRESS_PRESETS: Record<EgressPreset, readonly string[]> = {
  npm: ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"],
  github: [
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
  ],
  pypi: ["pypi.org", "files.pythonhosted.org"],
  maven: ["repo.maven.apache.org", "repo1.maven.org"],
  gradle: ["plugins.gradle.org", "services.gradle.org", "downloads.gradle.org"],
  go: ["proxy.golang.org", "sum.golang.org"],
  cargo: ["crates.io", "index.crates.io", "static.crates.io"],
};

export const egressAllowList = (egress: SandboxConfig["egress"]) => [
  ...new Set([...egress.presets.flatMap((preset) => EGRESS_PRESETS[preset]), ...egress.allow]),
];
