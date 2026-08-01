import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidAuthority,
  isValidLiveVersions,
  runtimeDigest,
} from "../scripts/check-client-release-authority.js";

const authority = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../vendor/cail-client-2.0.1.release-authority.json",
    ),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../package.json"),
    "utf8",
  ),
);
const publishWorkflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/publish.yml"),
  "utf8",
);

describe("client release version authority", () => {
  it("records the occupied release and preserves behavior bytes", () => {
    expect(isValidAuthority(authority)).toBe(true);
    expect(runtimeDigest()).toBe(
      "295aa0653c7277675fe5aec1c8198d9addc997205a78f2c58141c7942f1e2765",
    );
  });

  it("rechecks live authority immediately before a future publish", () => {
    expect(packageJson.version).toBe("2.0.1");
    expect(packageJson.scripts.prepublishOnly).toContain(
      "bun run check:clean",
    );
    expect(packageJson.scripts.prepublishOnly).toContain(
      "bun run check:release-live",
    );
    expect(publishWorkflow).toContain(
      "/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    );
    expect(publishWorkflow).toContain(
      'CAIL_REGISTRY_VERSIONS_FILE="$RUNNER_TEMP/cail-client-package-versions.json"',
    );
  });

  it("rejects forged local authority", () => {
    expect(
      isValidAuthority({
        ...authority,
        package: { ...authority.package, candidate_version: "2.0.0" },
      }),
    ).toBe(false);
    expect(
      isValidAuthority({
        ...authority,
        registry: {
          ...authority.registry,
          candidate_state: "published",
        },
      }),
    ).toBe(false);
  });

  it("requires the exact old registry identity and candidate absence", () => {
    const live = [
      {
        id: 1066318244,
        name: "2.0.0",
        created_at: "2026-07-25T17:33:30Z",
      },
    ];
    expect(isValidLiveVersions(live)).toBe(true);
    expect(
      isValidLiveVersions([
        ...live,
        {
          id: 1,
          name: "2.0.1",
          created_at: "2026-07-25T18:00:00Z",
        },
      ]),
    ).toBe(false);
    expect(
      isValidLiveVersions([{ ...live[0], id: 1066318245 }]),
    ).toBe(false);
  });
});
