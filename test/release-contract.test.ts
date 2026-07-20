import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  packageManager?: string;
  scripts?: Record<string, string>;
};
const ci = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const readme = readFileSync(
  new URL("../README.md", import.meta.url),
  "utf8",
);

const CHECKOUT_ACTION =
  "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd";
const SETUP_BUN_ACTION =
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";

describe("release and CI boundary", () => {
  it("pins reviewed CI actions and prevents checkout credential persistence", () => {
    expect(ci).toContain(`uses: ${CHECKOUT_ACTION}`);
    expect(ci).toContain(`uses: ${SETUP_BUN_ACTION}`);
    expect(ci).toMatch(/persist-credentials:\s*false/);
    expect(ci).not.toMatch(/uses:\s*actions\/checkout@v\d/);
    expect(ci).not.toMatch(/uses:\s*oven-sh\/setup-bun@v\d/);
  });

  it("scopes package registry credentials to the frozen install step", () => {
    const stepsStart = ci.indexOf("    steps:");
    expect(stepsStart).toBeGreaterThan(0);
    const jobConfiguration = ci.slice(0, stepsStart);
    const installStart = ci.indexOf("- name: Install frozen dependencies");
    const installEnd = ci.indexOf("\n      - name:", installStart + 1);
    const installStep = ci.slice(installStart, installEnd);
    expect(ci.match(/NODE_AUTH_TOKEN:/g)).toHaveLength(1);
    expect(jobConfiguration).not.toContain("NODE_AUTH_TOKEN:");
    expect(installStep).toContain("env:");
    expect(installStep).toContain("NODE_AUTH_TOKEN:");
    expect(installStep).toContain("run: bun install --frozen-lockfile");
  });

  it("runs the complete local gate before Bun can publish", () => {
    expect(packageJson.packageManager).toBe("bun@1.3.5");
    expect(packageJson.scripts?.["check"]).toContain("bun run check:format");
    expect(packageJson.scripts?.["check"]).toContain("bun run typecheck");
    expect(packageJson.scripts?.["check"]).toContain("bun run test");
    expect(packageJson.scripts?.["check"]).toContain("bun run check:package");
    expect(packageJson.scripts?.["check"]).toContain("bun run check:dist");
    expect(packageJson.scripts?.["prepublishOnly"]).toContain("bun run check");
    expect(packageJson.scripts?.["prepublishOnly"]).toContain(
      "bun run check:clean",
    );
  });

  it("documents Bun-native GitHub Packages publishing only", () => {
    expect(readme).toContain("bun publish --dry-run");
    expect(readme).toContain("bun publish");
    expect(readme).not.toContain("npm publish");
    expect(readme).not.toMatch(/Bun .*cannot authenticate/i);
  });
});
