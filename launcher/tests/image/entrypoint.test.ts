import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";

const entrypoint = () => readFile(join(launcherRoot(), "image", "entrypoint.sh"), "utf8");

describe("image entrypoint", () => {
  it("links every rendered entry into the agent dir, replacing only links or missing entries", async () => {
    const script = await entrypoint();

    expect(script).toContain("render_dir=/opt/pi-sandbox/render");
    expect(script).toMatch(/find "\$render_dir" -mindepth 1 -maxdepth 1 ! -name mcp-auth.json -exec sh -c/);
    expect(script).toContain('if [ -L "$link" ] || [ ! -e "$link" ]; then');
    expect(script).toContain('ln -sfn "$2" "$link"');
  });

  it("drops dangling links into the render dir and no longer links the image's own pi files", async () => {
    const script = await entrypoint();

    expect(script).toContain('-type l -lname "$render_dir/*" ! -exec test -e {} \\; -exec rm -f {} \\;');
    expect(script).not.toContain("/opt/pi-sandbox/auth.json");
    expect(script).not.toContain("/opt/pi-sandbox/models.json");
  });

  it("never links mcp-auth.json and drops a link left by an older render, so the file stays writable", async () => {
    const script = await entrypoint();

    expect(script).toContain('if [ -L "$agent_dir/mcp-auth.json" ]; then');
    expect(script).toContain('rm -f "$agent_dir/mcp-auth.json"');
  });

  it("seeds settings once and appends the mounted trust bundle to the CA bundle", async () => {
    const script = await entrypoint();

    expect(script).toContain('[ ! -e "$agent_dir/settings.json" ]');
    expect(script).toContain("trust_bundle=/etc/pi-sandbox/ca.pem");
    expect(script).toContain('cat "$trust_bundle" >> "$bundle_dir/ca-bundle.pem"');
  });
});
