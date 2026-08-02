import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historicalAuthorityPath = resolve(
  root,
  "vendor/cail-client-2.0.1.release-authority.json",
);
const candidateAuthorityPath = resolve(
  root,
  "vendor/cail-client-3.0.0.release-authority.json",
);
const expectedHistoricalRuntimeSha256 =
  "295aa0653c7277675fe5aec1c8198d9addc997205a78f2c58141c7942f1e2765";
const expectedCandidateRuntimeSha256 =
  "fc8c49c89ce3752846d25fe3434f834be0c9c5ea906fe1e87cb633cea839288a";

type Version = {
  id?: unknown;
  name?: unknown;
  created_at?: unknown;
};

type Authority = {
  schema_version?: unknown;
  package?: { name?: unknown; candidate_version?: unknown };
  behavior_authority?: {
    commit?: unknown;
    tree?: unknown;
    runtime_paths?: unknown;
    runtime_sha256?: unknown;
  };
  registry?: {
    url?: unknown;
    api?: unknown;
    observed_at?: unknown;
    published_versions?: unknown;
    candidate_state?: unknown;
  };
};

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
    candidate_version: "3.0.0",
  },
  behavior_authority: {
    commit: "605c040cd2915db75f056219f079911ccd860b8f",
    tree: "478d536a6a9f96089e406212bdf8e2d5461c97c1",
    runtime_paths: ["contract", "src"],
    runtime_sha256: expectedCandidateRuntimeSha256,
  },
  registry: {
    url: "https://npm.pkg.github.com",
    api: "https://api.github.com/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions",
    candidate_state: "live_preflight_required",
  },
};

export function isValidHistoricalAuthority(authority: Authority): boolean {
  return JSON.stringify(authority) === JSON.stringify(expectedHistoricalAuthority);
}

export function isValidCandidateAuthority(authority: Authority): boolean {
  return JSON.stringify(authority) === JSON.stringify(expectedCandidateAuthority);
}

export function isValidLiveVersions(versions: Version[]): boolean {
  return (
    versions.some(
      (version) =>
        version.id === 1066318244 &&
        version.name === "2.0.0" &&
        version.created_at === "2026-07-25T17:33:30Z",
    ) && !versions.some((version) => version.name === "3.0.0")
  );
}

function main(): void {
  const historicalAuthority = JSON.parse(
    readFileSync(historicalAuthorityPath, "utf8"),
  ) as Authority;
  const candidateAuthority = JSON.parse(
    readFileSync(candidateAuthorityPath, "utf8"),
  ) as Authority;
  const packageJson = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    !isValidHistoricalAuthority(historicalAuthority) ||
    !isValidCandidateAuthority(candidateAuthority) ||
    packageJson.name !== "@cuny-ai-lab/cail-client" ||
    packageJson.version !== "3.0.0" ||
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
        "cail-client: registry version authority changed or 3.0.0 already exists",
      );
    }
  }
}

const invoked = process.argv[1]
  ? resolve(process.argv[1])
  : undefined;
if (invoked === fileURLToPath(import.meta.url)) main();
