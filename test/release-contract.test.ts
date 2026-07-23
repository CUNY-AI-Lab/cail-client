import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
};
const bunLock = readFileSync(
  new URL("../bun.lock", import.meta.url),
  "utf8",
);
const ci = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const readme = readFileSync(
  new URL("../README.md", import.meta.url),
  "utf8",
);
const reviewedCailLogPath = fileURLToPath(
  new URL("../../cail-log-review-final-hardening/", import.meta.url),
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

  it("requires the corrected cail-log 0.6 contract without a vulnerable 0.4 lock", () => {
    expect(packageJson.dependencies?.["@cuny-ai-lab/cail-log"]).toBe("0.6.0");
    expect(bunLock).toContain('"@cuny-ai-lab/cail-log": "0.6.0"');
    expect(bunLock).toContain(
      "@cuny-ai-lab/cail-log@file:../cail-log-review-final-hardening",
    );
    expect(bunLock).not.toContain("@cuny-ai-lab/cail-log@0.4.0");
    expect(
      execFileSync(
        "git",
        ["-C", reviewedCailLogPath, "rev-parse", "HEAD^{commit}"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("0f4c6c2a08a4de0f07f827fe99bd15c5ecdd6659");
    expect(
      execFileSync(
        "git",
        ["-C", reviewedCailLogPath, "rev-parse", "HEAD^{tree}"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("d289a658e289ccd96122940bf7a4b7852e50fa75");
    expect(
      execFileSync(
        "git",
        [
          "-C",
          reviewedCailLogPath,
          "status",
          "--porcelain",
          "--untracked-files=all",
        ],
        { encoding: "utf8" },
      ),
    ).toBe("");
  });

  it("documents Bun-native GitHub Packages publishing only", () => {
    expect(readme).toContain("bun publish --dry-run");
    expect(readme).toContain("bun publish");
    expect(readme).not.toContain("npm publish");
    expect(readme).not.toMatch(/Bun .*cannot authenticate/i);
  });
});
