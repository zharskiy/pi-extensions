import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

const readText = (path: string) => readFileSync(join(ROOT, path), "utf8");

const manifest = JSON.parse(readText("package.json"));

const packedFiles = () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);

  const [pack] = JSON.parse(result.stdout) as { filename: string; files: { path: string }[] }[];

  return { filename: pack?.filename, paths: (pack?.files ?? []).map((file) => file.path) };
};

const stepOf = (workflow: string, name: string) => {
  const start = workflow.indexOf(`- name: ${name}\n`);
  const next = workflow.indexOf("\n      - ", start + 1);

  expect(start).toBeGreaterThan(-1);

  return workflow.slice(start, next < 0 ? undefined : next);
};

describe("the npm package", () => {
  it("is the public scoped package pinata", () => {
    expect(manifest.name).toBe("@zharskiy/pinata");
    expect(manifest.publishConfig).toEqual({ access: "public" });
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.repository.url).toBe("git+https://github.com/zharskiy/pi-extensions.git");
  });

  it("ships what the installer and pi need at runtime and nothing of the test or release tooling", {
    timeout: 30_000,
  }, () => {
    const { filename, paths } = packedFiles();

    expect(filename).toBe(`zharskiy-pinata-${manifest.version}.tgz`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        "LICENSE",
        "README.md",
        "CHANGELOG.md",
        "INSTALL.md",
        "install.sh",
        "launcher/install.sh",
        "launcher/uninstall.sh",
        "launcher/bin/pi-sandbox.js",
        "launcher/hostpi/provider-hosts.mjs",
        "launcher/examples/org/company-install.sh",
        "launcher/examples/org/config.json",
        "extensions/subagents/agents/leads/general.md",
        "extensions/subagents/prompts/main-session.md",
        ...manifest.pi.extensions.map((entry: string) => entry.replace(/^\.\//, "")),
      ]),
    );
    expect(
      paths.filter((path) =>
        /(^|\/)tests?\/|\.test\.ts$|^test\/|\.github\/|RELEASING\.md|release-please|pi-sandbox-dev\.js|tsconfig/.test(
          path,
        ),
      ),
    ).toEqual([]);
  });
});

const jobOf = (workflow: string, name: string) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);

  expect(start).toBeGreaterThan(-1);

  return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe("the release workflow", () => {
  const workflow = readText(".github/workflows/release.yml");

  it("publishes through npm trusted publishing, only when the repository variable NPM_PUBLISH is true", () => {
    const publish = stepOf(workflow, "Publish to npm");

    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(jobOf(workflow, "publish")).toContain("vars.NPM_PUBLISH == 'true'");
    expect(publish).toContain('npm publish "$TARBALL" --access public');
    expect(stepOf(workflow, "npm for trusted publishing")).toContain("npm install -g npm@^11.5.1");
  });

  it("gives id-token only to a publish job that installs no dependencies and uses no cache", () => {
    const build = jobOf(workflow, "build");
    const publish = jobOf(workflow, "publish");

    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(publish).toContain("permissions:\n      id-token: write\n    env:");
    expect(publish).not.toMatch(/npm ci|cache: npm|actions\/checkout/);
    expect(publish).toContain("package-manager-cache: false");
    expect(build).not.toContain("id-token");
    expect(build).toContain("npm ci");
  });

  it("skips the publish when that version is already on the registry", () => {
    expect(stepOf(workflow, "Already on the registry")).toContain('npm view "$NAME@$VERSION" version');
    expect(stepOf(workflow, "Publish to npm")).toContain("if: steps.published.outputs.skip != 'true'");
  });

  it("can build and publish an existing tag again by hand", () => {
    expect(workflow).toContain("workflow_dispatch:\n    inputs:\n      tag:");
    expect(jobOf(workflow, "build")).toContain("inputs.tag");
    expect(jobOf(workflow, "release-please")).toContain("if: github.event_name == 'push'");
  });

  it("pins every action by commit SHA with its version in a trailing comment", () => {
    const uses = [...workflow.matchAll(/uses: (\S+)(.*)$/gm)];

    expect(uses.length).toBeGreaterThan(0);
    expect(
      uses.filter((use) => !/@[0-9a-f]{40}$/.test(use[1] ?? "") || !/^ # v\d+\.\d+\.\d+$/.test(use[2] ?? "")),
    ).toEqual([]);
  });

  it("uploads the tarball, install.sh and SHA256SUMS to the GitHub release whether or not npm publishing is on", () => {
    const upload = stepOf(workflow, "Upload to the GitHub release");

    expect(jobOf(workflow, "build")).not.toContain("NPM_PUBLISH");
    expect(upload).toContain('gh release upload "$TAG" "$TARBALL" install.sh SHA256SUMS --clobber');
    expect(stepOf(workflow, "Pack")).toContain('sha256sum "$TARBALL" install.sh > SHA256SUMS');
  });

  it("names the tarball as npm pack names a scoped package", () => {
    const derive = stepOf(workflow, "Tag, package.json and install.sh agree");
    const name = manifest.name.replace(/^@/, "").replace("/", "-");

    expect(derive).toContain(`node -p 'require("./package.json").name.replace(/^@/, "").replace("/", "-")'`);
    expect(`${name}-${manifest.version}.tgz`).toBe(packedFiles().filename);
  });
});
