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
  "vendor/cail-client-3.0.0.release-authority.json",
);
const candidateAuthorityPath = resolve(
  root,
  "vendor/cail-client-3.0.1.release-authority.json",
);
const expectedHistoricalRuntimeSha256 =
  "295aa0653c7277675fe5aec1c8198d9addc997205a78f2c58141c7942f1e2765";
const expectedCandidateRuntimeSha256 =
  "ad2902c9e002c09524235460c9bc61b75bd1594297c0804afc5788ea723bb80c";

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
    candidate_version: "3.0.1",
  },
  behavior_authority: {
    commit: "9ac424e6e30e370bd804c283e72ddee6e53e11c9",
    tree: "1e89cb1e45bb9ed07257fb096a3668dfbe174a64",
    runtime_paths: ["contract", "src"],
    runtime_sha256: expectedCandidateRuntimeSha256,
  },
  registry: {
    url: "https://npm.pkg.github.com",
    api: "https://api.github.com/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    observed_at: "2026-08-07T14:18:44Z",
    published_versions: [
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
    version: "3.0.0",
  },
  behavior_authority: {
    commit: "605c040cd2915db75f056219f079911ccd860b8f",
    tree: "478d536a6a9f96089e406212bdf8e2d5461c97c1",
    runtime_paths: ["contract", "src"],
    runtime_sha256:
      "fc8c49c89ce3752846d25fe3434f834be0c9c5ea906fe1e87cb633cea839288a",
  },
  release: {
    tag: "v3.0.0",
    commit: "7f28944d6d262e8f61c7bca7d6833d2973078842",
    tree: "c242ca124301c9d07e4e4e20276901a03a174dff",
    release_id: 363834941,
    release_url:
      "https://github.com/CUNY-AI-Lab/cail-client/releases/tag/v3.0.0",
    published_at: "2026-08-02T16:28:59Z",
    workflow_run_id: 30756728587,
    workflow_run_url:
      "https://github.com/CUNY-AI-Lab/cail-client/actions/runs/30756728587",
    workflow_job_id: 91520060337,
    workflow_job_url:
      "https://github.com/CUNY-AI-Lab/cail-client/actions/runs/30756728587/job/91520060337",
    run_status: "completed",
    run_conclusion: "success",
  },
  registry: {
    url: "https://npm.pkg.github.com",
    api: "https://api.github.com/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    package_id: 13479481,
    version_id: 1091020674,
    version: "3.0.0",
    created_at: "2026-08-02T16:29:40Z",
    observed_at: "2026-08-06T20:48:40Z",
    state: "published",
    artifact: {
      url: "https://npm.pkg.github.com/download/@cuny-ai-lab/cail-client/3.0.0/8bd43f0ee8e218a40c34b21a116112a727901b5d",
      bytes: 61519,
      sha1: "8bd43f0ee8e218a40c34b21a116112a727901b5d",
      sha256:
        "4d50e0c051e14467ea9a79c4c744a8280dc1d8729cb98a0ef11be989fb245eaf",
      integrity:
        "sha512-HnKVCH+6PQedqD6WryxXMEi5mGzSqOo/wkOVFo9FMjGNaPqLLXMf5njcIJLjdA1pbKiASIM886wjep16f7lV5w==",
      git_tree_sha256:
        "6e9dcf302101086c2553ca6314e67d163dd719a24f3a2079c167b06b6931681e",
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

export function isValidLiveVersions(versions: Version[]): boolean {
  return (
    versions.some(
      (version) =>
        version.id === 1066318244 &&
        version.name === "2.0.0" &&
        version.created_at === "2026-07-25T17:33:30Z",
    ) &&
    versions.some(
      (version) =>
        version.id === 1091020674 &&
        version.name === "3.0.0" &&
        version.created_at === "2026-08-02T16:29:40Z",
    ) &&
    !versions.some((version) => version.name === "3.0.1")
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
    packageJson.version !== "3.0.1" ||
    runtimeDigest() !== expectedCandidateRuntimeSha256
  ) {
    throw new Error("cail-client: local release authority is invalid");
  }
  if (process.argv.includes("--live")) {
    const versionsPath = process.env.CAIL_REGISTRY_VERSIONS_FILE;
    if (!versionsPath) {
      throw new Error(
        "cail-client: live registry preflight requires CAIL_REGISTRY_VERSIONS_FILE",
      );
    }
    const versions = JSON.parse(
      readFileSync(versionsPath, "utf8"),
    ) as Version[];
    if (!Array.isArray(versions) || !isValidLiveVersions(versions)) {
      throw new Error(
        "cail-client: registry version authority changed or 3.0.1 is already published",
      );
    }
  }
}

const invoked = process.argv[1]
  ? resolve(process.argv[1])
  : undefined;
if (invoked === fileURLToPath(import.meta.url)) main();
