import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function readWorkflow(name: string): Promise<string> {
  return readFile(resolve(repositoryRoot, ".github", "workflows", name), "utf8");
}

describe("workflow supply-chain boundaries", () => {
  it("pins every third-party action to an immutable commit", async () => {
    const workflows = await Promise.all([
      readWorkflow("ci.yml"),
      readWorkflow("release.yml"),
    ]);
    const actionReferences = workflows.flatMap((workflow) =>
      Array.from(workflow.matchAll(/^\s*uses:\s*(\S+)/gmu), (match) => match[1] ?? "")
    );

    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) =>
      /^actions\/[a-z-]+@[0-9a-f]{40}$/u.test(reference)
    )).toBe(true);
  });

  it("uses exact supported Node versions and disables checkout credentials", async () => {
    const ci = await readWorkflow("ci.yml");
    const release = await readWorkflow("release.yml");

    expect(ci).toContain("- 20.20.2");
    expect(ci).toContain("- 22.23.1");
    expect(ci).toContain("- 24.18.0");
    expect(ci).toContain("persist-credentials: false");
    expect(ci).toContain("npm ci --ignore-scripts");
    expect(ci).not.toContain("id-token: write");

    expect(release).toContain("node-version: 24.18.0");
    expect(release.match(/node-version: 24\.18\.0/gu)).toHaveLength(2);
    expect(release.match(/persist-credentials: false/gu)).toHaveLength(1);
    expect(release).toContain("permissions: {}");
    expect(release).toContain("contents: read");
    expect(release).toContain("contents: write");
    expect(release).toContain("id-token: write");
  });

  it("keeps privileged publish work outside the repository-controlled build job", async () => {
    const release = await readWorkflow("release.yml");
    const publishStart = release.indexOf("\n  publish:");
    expect(publishStart).toBeGreaterThan(0);
    const build = release.slice(0, publishStart);
    const publish = release.slice(publishStart);

    expect(build).toContain("npm ci --ignore-scripts");
    expect(build).toContain("npm pack --ignore-scripts");
    expect(build).toContain("sha256sum ./*.tgz > SHA256SUMS");
    expect(build).toContain("actions/upload-artifact@");
    expect(build).not.toContain("contents: write");
    expect(build).not.toContain("id-token: write");
    expect(publish).toContain("actions/download-artifact@");
    expect(publish).toContain("sha256sum --check SHA256SUMS");
    expect(publish).toContain("npm publish ./*.tgz --ignore-scripts");
    expect(publish).not.toContain("actions/checkout@");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm run build");
    expect(publish).not.toContain("npm pack");
  });
});
