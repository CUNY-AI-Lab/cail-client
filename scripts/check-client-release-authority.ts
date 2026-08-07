import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historicalAuthorityPath = resolve(
  root,
  "vendor/cail-client-2.0.1.release-authority.json",
);
const publishedAuthorityPath = resolve(
  root,
  "vendor/cail-client-3.0.1.release-authority.json",
);
const candidateAuthorityPath = resolve(
  root,
  "vendor/cail-client-3.0.2.release-authority.json",
);
const expectedHistoricalRuntimeSha256 =
  "295aa0653c7277675fe5aec1c8198d9addc997205a78f2c58141c7942f1e2765";
const expectedCandidateRuntimeSha256 =
  "3856d7b082c542f3b51c3b5833dd6d9b997582289e3d71188974e9ae4a0d0e43";

type Version = {
  id?: unknown;
  name?: unknown;
  created_at?: unknown;
};

type Authority = Record<string, unknown>;

function filesBelow(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

export function runtimeDigest(): string {
  const files = ["contract", "src"]
    .flatMap((path) => filesBelow(resolve(root, path)))
    .sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const contents = readFileSync(path);
    hash.update(`${relative(root, path)}\0${contents.length}\0`);
    hash.update(contents);
  }
  return hash.digest("hex");
}

const expectedHistoricalAuthority = {
  schema_version: 1,
  package: {
    name: "@cuny-ai-lab/cail-client",
    candidate_version: "2.0.1",
  },
  behavior_authority: {
    commit: "7f5e73ce2b6fc6a7a490767a4369206cd21b0547",
    tree: "c035e086c2ede410f2f9ec4a02fb4581c10f8c84",
    runtime_paths: ["contract", "src"],
    runtime_sha256: expectedHistoricalRuntimeSha256,
  },
  registry: {
    url: "https://npm.pkg.github.com",
    api: "https://api.github.com/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    observed_at: "2026-07-25T21:36:35Z",
    published_versions: [
      {
        version: "2.0.0",
        package_version_id: 1066318244,
        published_at: "2026-07-25T17:33:30Z",
      },
      {
        version: "1.3.0",
        package_version_id: 1046114991,
        published_at: "2026-07-19T22:33:40Z",
      },
      {
        version: "1.2.0",
        package_version_id: 1045905844,
        published_at: "2026-07-19T19:58:29Z",
      },
      {
        version: "1.1.0",
        package_version_id: 1045861034,
        published_at: "2026-07-19T19:27:44Z",
      },
    ],
    candidate_state: "not_published",
  },
};

const expectedCandidateAuthority = {
  schema_version: 1,
  package: {
    name: "@cuny-ai-lab/cail-client",
    candidate_version: "3.0.2",
  },
  behavior_authority: {
    commit: "7604c62177a9c6dca3e37bf8b8fd8bd39ece0fff",
    tree: "8bdd36a7d1d18d19df0733a874c2e2fd590ebbbf",
    runtime_paths: ["contract", "src"],
    runtime_sha256: expectedCandidateRuntimeSha256,
  },
  registry: {
    url: "https://npm.pkg.github.com",
    api: "https://api.github.com/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    observed_at: "2026-08-07T22:31:24Z",
    published_versions: [
      {
        version: "3.0.1",
        package_version_id: 1109448066,
        published_at: "2026-08-07T16:38:11Z",
      },
      {
        version: "3.0.0",
        package_version_id: 1091020674,
        published_at: "2026-08-02T16:29:40Z",
      },
      {
        version: "2.0.0",
        package_version_id: 1066318244,
        published_at: "2026-07-25T17:33:30Z",
      },
      {
        version: "1.3.0",
        package_version_id: 1046114991,
        published_at: "2026-07-19T22:33:40Z",
      },
      {
        version: "1.2.0",
        package_version_id: 1045905844,
        published_at: "2026-07-19T19:58:29Z",
      },
      {
        version: "1.1.0",
        package_version_id: 1045861034,
        published_at: "2026-07-19T19:27:44Z",
      },
    ],
    candidate_state: "not_published",
  },
};

const expectedPublishedAuthority = {
  schema_version: 1,
  package: {
    name: "@cuny-ai-lab/cail-client",
    version: "3.0.1",
  },
  behavior_authority: {
    commit: "9ac424e6e30e370bd804c283e72ddee6e53e11c9",
    tree: "1e89cb1e45bb9ed07257fb096a3668dfbe174a64",
    runtime_paths: ["contract", "src"],
    runtime_sha256:
      "ad2902c9e002c09524235460c9bc61b75bd1594297c0804afc5788ea723bb80c",
  },
  release: {
    tag: "v3.0.1",
    commit: "1a3333712055d0cd452884222d273b8c7d1ffcda",
    tree: "536a592f0cd0e82b99f70a9adf6455bac312c239",
    release_id: 366881063,
    release_url:
      "https://github.com/CUNY-AI-Lab/cail-client/releases/tag/v3.0.1",
    published_at: "2026-08-07T16:37:27Z",
    workflow_run_id: 31198471277,
    workflow_run_url:
      "https://github.com/CUNY-AI-Lab/cail-client/actions/runs/31198471277",
    workflow_job_id: 92932398277,
    workflow_job_url:
      "https://github.com/CUNY-AI-Lab/cail-client/actions/runs/31198471277/job/92932398277",
    run_status: "completed",
    run_conclusion: "success",
  },
  registry: {
    url: "https://npm.pkg.github.com",
    api: "https://api.github.com/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    package_id: 13479481,
    version_id: 1109448066,
    version: "3.0.1",
    created_at: "2026-08-07T16:38:11Z",
    observed_at: "2026-08-07T22:31:51Z",
    state: "published",
    artifact: {
      url: "https://npm.pkg.github.com/download/@cuny-ai-lab/cail-client/3.0.1/08719b1978a95c1bb9b5b19c5773dbbe6bfbffbd",
      bytes: 61519,
      sha1: "08719b1978a95c1bb9b5b19c5773dbbe6bfbffbd",
      sha256:
        "d6adff8834637bbfcd1fa30778ade86ef34f340eee29e39c1cbfcdad4d7ec06c",
      integrity:
        "sha512-fS8p50xk5aU+omY7+wVEQD+GNHIQBHwvilliJSe43m8Wxc7HeMbMxVhokNVE3Sfn3r+RvhewXaZ0e5SHoR24CQ==",
      git_tree_sha256:
        "d4640e4b5ef1d0d63c403dbef89a952642c567ff81ea22dbb609759ed3c4e890",
    },
  },
};

export function isValidHistoricalAuthority(authority: Authority): boolean {
  return JSON.stringify(authority) === JSON.stringify(expectedHistoricalAuthority);
}

export function isValidCandidateAuthority(authority: Authority): boolean {
  return JSON.stringify(authority) === JSON.stringify(expectedCandidateAuthority);
}

export function isValidPublishedAuthority(authority: Authority): boolean {
  return JSON.stringify(authority) === JSON.stringify(expectedPublishedAuthority);
}

function hasVersion(
  versions: Version[],
  id: number,
  name: string,
  createdAt: string,
): boolean {
  const matches = versions.filter((version) => version.name === name);
  return (
    matches.length === 1 &&
    matches[0]?.id === id &&
    matches[0]?.created_at === createdAt
  );
}

export function isValidPublicationPreflight(versions: Version[]): boolean {
  return (
    hasVersion(versions, 1109448066, "3.0.1", "2026-08-07T16:38:11Z") &&
    hasVersion(versions, 1066318244, "2.0.0", "2026-07-25T17:33:30Z") &&
    !versions.some((version) => version.name === "3.0.2")
  );
}

export function isValidLiveVersions(versions: Version[]): boolean {
  return (
    hasVersion(versions, 1109448066, "3.0.1", "2026-08-07T16:38:11Z") &&
    hasVersion(versions, 1066318244, "2.0.0", "2026-07-25T17:33:30Z") &&
    versions.filter((version) => version.name === "3.0.2").length === 1
  );
}

function main(): void {
  const historicalAuthority = JSON.parse(
    readFileSync(historicalAuthorityPath, "utf8"),
  ) as Authority;
  const publishedAuthority = JSON.parse(
    readFileSync(publishedAuthorityPath, "utf8"),
  ) as Authority;
  const candidateAuthority = JSON.parse(
    readFileSync(candidateAuthorityPath, "utf8"),
  ) as Authority;
  const packageJson = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    !isValidHistoricalAuthority(historicalAuthority) ||
    !isValidPublishedAuthority(publishedAuthority) ||
    !isValidCandidateAuthority(candidateAuthority) ||
    packageJson.name !== "@cuny-ai-lab/cail-client" ||
    packageJson.version !== "3.0.2" ||
    runtimeDigest() !== expectedCandidateRuntimeSha256
  ) {
    throw new Error("cail-client: local release authority is invalid");
  }
  if (process.argv.includes("--publication-preflight") || process.argv.includes("--live")) {
    const versionsPath = process.env.CAIL_REGISTRY_VERSIONS_FILE;
    if (!versionsPath) {
      throw new Error(
        "cail-client: registry preflight requires CAIL_REGISTRY_VERSIONS_FILE",
      );
    }
    const versions = JSON.parse(
      readFileSync(versionsPath, "utf8"),
    ) as Version[];
    const valid =
      Array.isArray(versions) &&
      (process.argv.includes("--publication-preflight")
        ? isValidPublicationPreflight(versions)
        : isValidLiveVersions(versions));
    if (!valid) {
      throw new Error(
        process.argv.includes("--publication-preflight")
          ? "cail-client: publication preflight blocked; 3.0.2 is already published or the registry snapshot is incomplete"
          : "cail-client: published registry version authority changed or 3.0.2 is unavailable",
      );
    }
  }
}

const invoked = process.argv[1]
  ? resolve(process.argv[1])
  : undefined;
if (invoked === fileURLToPath(import.meta.url)) main();
