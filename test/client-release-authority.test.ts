import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidHistoricalAuthority,
  isValidArtifactBytes,
  isValidPublicationPreflight,
  isValidPublishedAuthority,
  isValidPublishedSourceTag,
  isValidPublishedVersions,
  artifactDigest,
  downloadAndVerifyPublishedArtifact,
  hashGitTree,
  runtimeDigest,
  verifyPublishedArtifactArchive,
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
      "../vendor/cail-client-3.0.0.release-authority.json",
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
      "/repos/CUNY-AI-Lab/cail-client/git/ref/tags/v3.0.0",
      { object: { sha: tagSha, type: "commit" } },
    ],
  ]);
  return async (path) => {
    if (!responses.has(path)) throw new Error(`unexpected API path: ${path}`);
    return responses.get(path);
  };
}

const exactReleaseContext = {
  packageVersion: "3.0.0",
  repository: "CUNY-AI-Lab/cail-client",
  refType: "tag",
  refName: "v3.0.0",
  sha: currentHead,
} as const;

describe("client release version authority", () => {
  it("preserves historical authority and binds the published behavior bytes", () => {
    expect(isValidHistoricalAuthority(historicalAuthority)).toBe(true);
    expect(isValidPublishedAuthority(publishedAuthority)).toBe(true);
    expect(runtimeDigest()).toBe(
      "fc8c49c89ce3752846d25fe3434f834be0c9c5ea906fe1e87cb633cea839288a",
    );
    expect(publishedAuthority.package).toEqual({
      name: "@cuny-ai-lab/cail-client",
      version: "3.0.0",
    });
    expect(publishedAuthority.behavior_authority).toMatchObject({
      commit: "605c040cd2915db75f056219f079911ccd860b8f",
      tree: "478d536a6a9f96089e406212bdf8e2d5461c97c1",
    });
    expect(publishedAuthority.release).toMatchObject({
      tag: "v3.0.0",
      commit: "7f28944d6d262e8f61c7bca7d6833d2973078842",
      tree: "c242ca124301c9d07e4e4e20276901a03a174dff",
      release_id: 363834941,
      published_at: "2026-08-02T16:28:59Z",
      run_conclusion: "success",
    });
    expect(publishedAuthority.registry).toMatchObject({
      package_id: 13479481,
      version_id: 1091020674,
      version: "3.0.0",
      created_at: "2026-08-02T16:29:40Z",
      observed_at: "2026-08-06T20:48:40Z",
      state: "published",
      artifact: {
        bytes: 61519,
        sha1: "8bd43f0ee8e218a40c34b21a116112a727901b5d",
        sha256:
          "4d50e0c051e14467ea9a79c4c744a8280dc1d8729cb98a0ef11be989fb245eaf",
        integrity:
          "sha512-HnKVCH+6PQedqD6WryxXMEi5mGzSqOo/wkOVFo9FMjGNaPqLLXMf5njcIJLjdA1pbKiASIM886wjep16f7lV5w==",
        git_tree_sha256:
          "6e9dcf302101086c2553ca6314e67d163dd719a24f3a2079c167b06b6931681e",
      },
    });
    expect(publishedAuthority.release).toMatchObject({
      workflow_run_id: 30756728587,
      workflow_job_id: 91520060337,
      run_status: "completed",
    });
  });

  it("rechecks live authority immediately before a future publish", () => {
    expect(packageJson.version).toBe("3.0.0");
    expect(packageJson.scripts.prepublishOnly).toContain(
      "bun run check:clean",
    );
    expect(packageJson.scripts.prepublishOnly).toContain(
      "bun run check:release-ref",
    );
    expect(packageJson.scripts.prepublishOnly).toContain(
      "bun run check:publication-preflight",
    );
    expect(packageJson.scripts.prepublishOnly).not.toContain(
      "bun run check:release-live",
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
    expect(publishWorkflow).toContain("bun run check:publication-preflight");
    expect(publishWorkflow).not.toContain("bun run check:release-live");
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
      isValidPublishedAuthority({
        ...publishedAuthority,
        package: {
          ...publishedAuthority.package,
          version: "2.0.0",
        },
      }),
    ).toBe(false);
    expect(
      isValidPublishedAuthority({
        ...publishedAuthority,
        behavior_authority: {
          ...publishedAuthority.behavior_authority,
          tree: "0".repeat(40),
        },
      }),
    ).toBe(false);
    expect(
      isValidPublishedAuthority({
        ...publishedAuthority,
        release: {
          ...publishedAuthority.release,
          commit: "0".repeat(40),
        },
      }),
    ).toBe(false);
    expect(
      isValidPublishedAuthority({
        ...publishedAuthority,
        registry: {
          ...publishedAuthority.registry,
          version_id: 1091020675,
        },
      }),
    ).toBe(false);
    expect(
      isValidPublishedAuthority({
        ...publishedAuthority,
        registry: {
          ...publishedAuthority.registry,
          artifact: undefined,
        },
      }),
    ).toBe(false);
    expect(
      isValidPublishedAuthority({
        ...publishedAuthority,
        stale_candidate_state: "not_published",
      }),
    ).toBe(false);
    const reordered = JSON.parse(
      JSON.stringify({
        registry: publishedAuthority.registry,
        release: publishedAuthority.release,
        behavior_authority: publishedAuthority.behavior_authority,
        package: publishedAuthority.package,
        schema_version: publishedAuthority.schema_version,
      }),
    );
    expect(isValidPublishedAuthority(reordered)).toBe(true);
  });

  it("requires the exact published registry identity", () => {
    const live = [
      {
        id: 1091020674,
        name: "3.0.0",
        created_at: "2026-08-02T16:29:40Z",
      },
      {
        id: 1066318244,
        name: "2.0.0",
        created_at: "2026-07-25T17:33:30Z",
      },
    ];
    expect(isValidPublishedVersions(live)).toBe(true);
    expect(
      isValidPublishedVersions([
        ...live,
        { ...live[0]!, id: 1 },
      ]),
    ).toBe(false);
    expect(
      isValidPublishedVersions([{ ...live[0]!, id: 1091020675 }, live[1]!]),
    ).toBe(false);
    expect(
      isValidPublishedVersions(live.filter((version) => version.name !== "3.0.0")),
    ).toBe(false);
    expect(
      isValidPublishedVersions([...live, { ...live[0] }]),
    ).toBe(false);
    expect(
      isValidPublishedVersions([{ ...live[0], created_at: undefined }, live[1]]),
    ).toBe(false);
    expect(isValidPublishedVersions([live[1]])).toBe(false);
  });

  it("fails publication preflight for missing or occupied versions", () => {
    const historicalOnly = [
      {
        id: 1066318244,
        name: "2.0.0",
        created_at: "2026-07-25T16:33:30Z",
      },
    ];
    const exactHistoricalOnly = [
      {
        id: 1066318244,
        name: "2.0.0",
        created_at: "2026-07-25T17:33:30Z",
      },
    ];
    expect(isValidPublicationPreflight(exactHistoricalOnly)).toBe(true);
    expect(
      isValidPublicationPreflight([
        ...exactHistoricalOnly,
        {
          id: 1091020674,
          name: "3.0.0",
          created_at: "2026-08-02T16:29:40Z",
        },
      ]),
    ).toBe(false);
    expect(isValidPublicationPreflight(historicalOnly)).toBe(false);
    expect(
      isValidPublicationPreflight([
        ...exactHistoricalOnly,
        { id: 1, name: "3.0.0", created_at: "not-a-date" },
      ]),
    ).toBe(false);
    expect(isValidPublicationPreflight(exactHistoricalOnly, "4.0.0")).toBe(true);
  });

  it("rejects corrupt or missing published artifact bytes", () => {
    const artifact = publishedAuthority.registry.artifact;
    expect(isValidArtifactBytes(Buffer.from("corrupt"), artifact)).toBe(false);
    expect(isValidArtifactBytes(Buffer.from("corrupt"), undefined)).toBe(false);
  });

  it("downloads and verifies fixture tarball bytes, auth, and Git-tree content", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "cail-client-authority-fixture-"));
    try {
      const packageRoot = join(temporary, "package");
      const archivePath = join(temporary, "fixture.tgz");
      mkdirSync(packageRoot);
      writeFileSync(
        join(packageRoot, "package.json"),
        '{"name":"fixture","version":"0.0.0"}\n',
      );
      writeFileSync(join(packageRoot, "index.js"), "export {};\n");
      const packed = spawnSync(
        "tar",
        ["-czf", archivePath, "-C", temporary, "package"],
        { encoding: "utf8" },
      );
      expect(packed.status, `${packed.stdout ?? ""}${packed.stderr ?? ""}`).toBe(0);
      const bytes = readFileSync(archivePath);
      const artifact = {
        url: "https://fixture.invalid/cail-client.tgz",
        ...artifactDigest(bytes),
        git_tree_sha256: hashGitTree(packageRoot),
      };
      expect(() => verifyPublishedArtifactArchive(archivePath, artifact)).not.toThrow();
      const requests: Array<{ url: string; authorization: string }> = [];
      const fixtureFetch: typeof fetch = async (url, init) => {
        requests.push({
          url: String(url),
          authorization: String(new Headers(init?.headers).get("authorization")),
        });
        return new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) },
        });
      };
      await downloadAndVerifyPublishedArtifact(artifact, "fixture-token", fixtureFetch);
      expect(requests).toEqual([
        {
          url: artifact.url,
          authorization: "Bearer fixture-token",
        },
      ]);
      await expect(
        downloadAndVerifyPublishedArtifact(
          artifact,
          "fixture-token",
          async () => new Response(Buffer.from("corrupt"), { status: 200 }),
        ),
      ).rejects.toThrow("bytes do not match");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("binds the published tag to its exact source commit and tree", () => {
    expect(
      isValidPublishedSourceTag({
        commit: "7f28944d6d262e8f61c7bca7d6833d2973078842",
        tree: "c242ca124301c9d07e4e4e20276901a03a174dff",
      }),
    ).toBe(true);
    expect(
      isValidPublishedSourceTag({
        commit: "7f28944d6d262e8f61c7bca7d6833d2973078842",
        tree: "0".repeat(40),
      }),
    ).toBe(false);
    expect(
      isValidPublishedSourceTag({
        commit: "0".repeat(40),
        tree: "c242ca124301c9d07e4e4e20276901a03a174dff",
      }),
    ).toBe(false);
  });
});
