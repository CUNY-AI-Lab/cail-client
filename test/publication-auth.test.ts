import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const npmrc = readFileSync(resolve(root, ".npmrc"), "utf8");
const publishWorkflow = readFileSync(
  resolve(root, ".github/workflows/publish.yml"),
  "utf8",
);

describe("GitHub Packages publication authentication", () => {
  it("uses the same non-secret token variable in npmrc and the publish job", () => {
    const authLine = npmrc.match(
      /^\/\/npm\.pkg\.github\.com\/:_authToken=\$\{([A-Z][A-Z0-9_]*)\}$/m,
    );
    expect(authLine).not.toBeNull();
    const authVariable = authLine?.[1];
    expect(authVariable).toBe("NODE_AUTH_TOKEN");
    expect(publishWorkflow).toContain(
      `          ${authVariable}: \${{ secrets.GITHUB_TOKEN }}`,
    );
    expect(publishWorkflow).not.toContain("NPM_CONFIG_TOKEN");
  });
});
