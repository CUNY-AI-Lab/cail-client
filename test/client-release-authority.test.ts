import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidCandidateAuthority,
  isValidHistoricalAuthority,
  isValidLiveVersions,
  isValidPublicationPreflight,
  isValidPublishedAuthority,
  runtimeDigest,
} from "../scripts/check-client-release-authority.js";
import {
  type GithubJson,
  verifyReleaseRef,
} from "../scripts/check-client-release-ref.js";

const historicalAuthority = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../vendor/cail-client-2.0.1.release-authority.json",
    ),
    "utf8",
  ),
);
const publishedAuthority = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../vendor/cail-client-3.0.1.release-authority.json",
    ),
    "utf8",
  ),
);
const candidateAuthority = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../vendor/cail-client-3.0.2.release-authority.json",
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

const currentHead = "a".repeat(40);
const oldHead = "b".repeat(40);

function releaseApi(tagSha: string, branchSha: string): GithubJson {
  const responses = new Map<string, unknown>([
    [
      "/repos/CUNY-AI-Lab/cail-client",
      { default_branch: "main" },
    ],
    [
      "/repos/CUNY-AI-Lab/cail-client/git/ref/heads/main",
      { object: { sha: branchSha, type: "commit" } },
    ],
    [
      "/repos/CUNY-AI-Lab/cail-client/git/ref/tags/v3.0.2",
      { object: { sha: tagSha, type: "commit" } },
    ],
  ]);
  return async (path) => {
    if (!responses.has(path)) throw new Error(`unexpected API path: ${path}`);
    return responses.get(path);
  };
}

const exactReleaseContext = {
  packageVersion: "3.0.2",
  repository: "CUNY-AI-Lab/cail-client",
  refType: "tag",
  refName: "v3.0.2",
  sha: currentHead,
} as const;

describe("client release version authority", () => {
  it("preserves 3.0.1 evidence and binds the 3.0.2 candidate", () => {
    expect(isValidHistoricalAuthority(historicalAuthority)).toBe(true);
    expect(isValidPublishedAuthority(publishedAuthority)).toBe(true);
    expect(isValidCandidateAuthority(candidateAuthority)).toBe(true);
    expect(runtimeDigest()).toBe(
      "3856d7b082c542f3b51c3b5833dd6d9b997582289e3d71188974e9ae4a0d0e43",
    );
  });

  it("rechecks live authority immediately before a future publish", () => {
    expect(packageJson.version).toBe("3.0.2");
    expect(packageJson.scripts.prepublishOnly).toContain(
      "bun run check:clean",
    );
    expect(packageJson.scripts.prepublishOnly).toContain(
      "bun run check:publication-preflight",
    );
    expect(publishWorkflow).toContain(
      "/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    );
    expect(publishWorkflow).toContain("--paginate");
    expect(publishWorkflow).toContain("jq -s 'add'");
    expect(publishWorkflow).toMatch(
      /set -o pipefail\s+gh api --paginate/u,
    );
    expect(publishWorkflow).toContain(
      'CAIL_REGISTRY_VERSIONS_FILE="$RUNNER_TEMP/cail-client-package-versions.json"',
    );
    expect(publishWorkflow).toContain(
      "bun run check:publication-preflight",
    );
    expect(publishWorkflow).toContain(
      "github.event.release.prerelease == false",
    );
    expect(publishWorkflow).toContain("bun run check:release-ref");
    expect(publishWorkflow.match(/bun run check:release-ref/gu)).toHaveLength(2);
    expect(publishWorkflow).toContain("timeout-minutes: 15");
    expect(publishWorkflow).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(publishWorkflow).toContain("GITHUB_REF_TYPE: ${{ github.ref_type }}");
    expect(publishWorkflow).toContain("GITHUB_REF_NAME: ${{ github.ref_name }}");
    expect(publishWorkflow).toContain("GITHUB_SHA: ${{ github.sha }}");
    expect(publishWorkflow).not.toContain(
      "Verify release tag matches package version",
    );
  });

  it("rejects a version-matching tag that is not the live default-branch head", async () => {
    await expect(
      verifyReleaseRef(
        { ...exactReleaseContext, sha: oldHead },
        releaseApi(oldHead, currentHead),
      ),
    ).rejects.toThrow("live default-branch head");
  });

  it("rejects an old-head GITHUB_SHA even when the tag name is correct", async () => {
    await expect(
      verifyReleaseRef(
        { ...exactReleaseContext, sha: oldHead },
        releaseApi(currentHead, currentHead),
      ),
    ).rejects.toThrow("GITHUB_SHA is not the commit named by the release tag");
  });

  it("accepts an exact tag, tag commit, and live default-branch head", async () => {
    await expect(
      verifyReleaseRef(exactReleaseContext, releaseApi(currentHead, currentHead)),
    ).resolves.toBeUndefined();
  });

  it("rejects forged local authority", () => {
    expect(
      isValidCandidateAuthority({
        ...candidateAuthority,
        package: {
          ...candidateAuthority.package,
          candidate_version: "3.0.1",
        },
      }),
    ).toBe(false);
    expect(
      isValidCandidateAuthority({
        ...candidateAuthority,
        registry: {
          ...candidateAuthority.registry,
          candidate_state: "published",
        },
      }),
    ).toBe(false);
  });

  it("requires the exact registry identity and current candidate absence", () => {
    const live = [
      {
        id: 1109448066,
        name: "3.0.1",
        created_at: "2026-08-07T16:38:11Z",
      },
      {
        id: 1066318244,
        name: "2.0.0",
        created_at: "2026-07-25T17:33:30Z",
      },
    ];
    expect(isValidPublicationPreflight(live)).toBe(true);
    expect(
      isValidPublicationPreflight([
        ...live,
        {
          id: 1,
          name: "3.0.2",
          created_at: "2026-08-07T22:31:24Z",
        },
      ]),
    ).toBe(false);
    expect(
      isValidPublicationPreflight([{ ...live[0], id: 1109448067 }, live[1]!]),
    ).toBe(false);
    expect(
      isValidLiveVersions([
        ...live,
        { id: 7, name: "3.0.2", created_at: "2026-08-07T22:35:00Z" },
      ]),
    ).toBe(true);
  });
});
