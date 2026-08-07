import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historicalAuthorityPath = resolve(
  root,
  "vendor/cail-client-2.0.1.release-authority.json",
);
const releaseAuthorityPath = resolve(
  root,
  "vendor/cail-client-3.0.0.release-authority.json",
);
const expectedHistoricalRuntimeSha256 =
  "295aa0653c7277675fe5aec1c8198d9addc997205a78f2c58141c7942f1e2765";
const expectedPublishedRuntimeSha256 =
  "fc8c49c89ce3752846d25fe3434f834be0c9c5ea906fe1e87cb633cea839288a";
const expectedPublishedBehaviorCommit =
  "605c040cd2915db75f056219f079911ccd860b8f";
const expectedPublishedBehaviorTree =
  "478d536a6a9f96089e406212bdf8e2d5461c97c1";
const expectedPublishedReleaseCommit =
  "7f28944d6d262e8f61c7bca7d6833d2973078842";
const expectedPublishedReleaseTree =
  "c242ca124301c9d07e4e4e20276901a03a174dff";
const expectedPublishedVersion = "3.0.0";
const expectedHistoricalVersion = "2.0.0";
const githubApiVersion = "2026-03-10";
const maxArtifactBytes = 8 * 1024 * 1024;
const artifactRequestTimeoutMs = 30_000;

type JsonRecord = Record<string, unknown>;

export type Version = {
  id?: unknown;
  name?: unknown;
  created_at?: unknown;
};

export type Authority = {
  schema_version?: unknown;
  package?: JsonRecord;
  behavior_authority?: JsonRecord;
  release?: JsonRecord;
  registry?: JsonRecord;
};

export type PublishedArtifact = {
  url: string;
  bytes: number;
  sha1: string;
  sha256: string;
  integrity: string;
  git_tree_sha256: string;
};

type ArtifactDigest = Omit<PublishedArtifact, "url" | "git_tree_sha256">;

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: unknown, keys: readonly string[]): value is JsonRecord {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
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

const expectedPublishedArtifact: PublishedArtifact = {
  url: "https://npm.pkg.github.com/download/@cuny-ai-lab/cail-client/3.0.0/8bd43f0ee8e218a40c34b21a116112a727901b5d",
  bytes: 61519,
  sha1: "8bd43f0ee8e218a40c34b21a116112a727901b5d",
  sha256:
    "4d50e0c051e14467ea9a79c4c744a8280dc1d8729cb98a0ef11be989fb245eaf",
  integrity:
    "sha512-HnKVCH+6PQedqD6WryxXMEi5mGzSqOo/wkOVFo9FMjGNaPqLLXMf5njcIJLjdA1pbKiASIM886wjep16f7lV5w==",
  git_tree_sha256:
    "6e9dcf302101086c2553ca6314e67d163dd719a24f3a2079c167b06b6931681e",
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

export function isValidHistoricalAuthority(authority: Authority): boolean {
  if (
    !exactKeys(authority, [
      "schema_version",
      "package",
      "behavior_authority",
      "registry",
    ]) ||
    authority.schema_version !== expectedHistoricalAuthority.schema_version ||
    !exactKeys(authority.package, ["name", "candidate_version"]) ||
    !exactKeys(authority.behavior_authority, [
      "commit",
      "tree",
      "runtime_paths",
      "runtime_sha256",
    ]) ||
    !exactKeys(authority.registry, [
      "url",
      "api",
      "observed_at",
      "published_versions",
      "candidate_state",
    ])
  ) {
    return false;
  }
  const packageAuthority = authority.package;
  const behavior = authority.behavior_authority;
  const registry = authority.registry;
  const publishedVersions = registry.published_versions;
  if (
    packageAuthority.name !== expectedHistoricalAuthority.package.name ||
    packageAuthority.candidate_version !==
      expectedHistoricalAuthority.package.candidate_version ||
    behavior.commit !== expectedHistoricalAuthority.behavior_authority.commit ||
    behavior.tree !== expectedHistoricalAuthority.behavior_authority.tree ||
    behavior.runtime_sha256 !==
      expectedHistoricalAuthority.behavior_authority.runtime_sha256 ||
    !exactStrings(behavior.runtime_paths, ["contract", "src"]) ||
    registry.url !== expectedHistoricalAuthority.registry.url ||
    registry.api !== expectedHistoricalAuthority.registry.api ||
    registry.observed_at !== expectedHistoricalAuthority.registry.observed_at ||
    registry.candidate_state !== expectedHistoricalAuthority.registry.candidate_state ||
    !Array.isArray(publishedVersions) ||
    publishedVersions.length !==
      expectedHistoricalAuthority.registry.published_versions.length
  ) {
    return false;
  }
  return publishedVersions.every((entry, index) => {
    const expected = expectedHistoricalAuthority.registry.published_versions[index];
    return (
      exactKeys(entry, ["version", "package_version_id", "published_at"]) &&
      expected !== undefined &&
      entry.version === expected.version &&
      entry.package_version_id === expected.package_version_id &&
      entry.published_at === expected.published_at
    );
  });
}

function isArtifactShape(value: unknown): value is PublishedArtifact {
  return (
    exactKeys(value, [
      "url",
      "bytes",
      "sha1",
      "sha256",
      "integrity",
      "git_tree_sha256",
    ]) &&
    typeof value.url === "string" &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.sha1 === "string" &&
    /^[0-9a-f]{40}$/iu.test(value.sha1) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/iu.test(value.sha256) &&
    typeof value.integrity === "string" &&
    /^sha512-[A-Za-z0-9+/]+=*$/u.test(value.integrity) &&
    typeof value.git_tree_sha256 === "string" &&
    /^[0-9a-f]{64}$/iu.test(value.git_tree_sha256)
  );
}

function isValidPublishedArtifactMetadata(value: unknown): value is PublishedArtifact {
  return (
    isArtifactShape(value) &&
    value.url === expectedPublishedArtifact.url &&
    value.bytes === expectedPublishedArtifact.bytes &&
    value.sha1 === expectedPublishedArtifact.sha1 &&
    value.sha256 === expectedPublishedArtifact.sha256 &&
    value.integrity === expectedPublishedArtifact.integrity &&
    value.git_tree_sha256 === expectedPublishedArtifact.git_tree_sha256
  );
}

export function isValidPublishedAuthority(authority: Authority): boolean {
  if (
    !exactKeys(authority, [
      "schema_version",
      "package",
      "behavior_authority",
      "release",
      "registry",
    ]) ||
    authority.schema_version !== 1 ||
    !exactKeys(authority.package, ["name", "version"]) ||
    !exactKeys(authority.behavior_authority, [
      "commit",
      "tree",
      "runtime_paths",
      "runtime_sha256",
    ]) ||
    !exactKeys(authority.release, [
      "tag",
      "commit",
      "tree",
      "release_id",
      "release_url",
      "published_at",
      "workflow_run_id",
      "workflow_run_url",
      "workflow_job_id",
      "workflow_job_url",
      "run_status",
      "run_conclusion",
    ]) ||
    !exactKeys(authority.registry, [
      "url",
      "api",
      "package_id",
      "version_id",
      "version",
      "created_at",
      "observed_at",
      "state",
      "artifact",
    ])
  ) {
    return false;
  }
  const packageAuthority = authority.package;
  const behavior = authority.behavior_authority;
  const release = authority.release;
  const registry = authority.registry;
  return (
    packageAuthority.name === "@cuny-ai-lab/cail-client" &&
    packageAuthority.version === expectedPublishedVersion &&
    behavior.commit === expectedPublishedBehaviorCommit &&
    behavior.tree === expectedPublishedBehaviorTree &&
    String(behavior.commit) !== expectedPublishedReleaseCommit &&
    String(behavior.tree) !== expectedPublishedReleaseTree &&
    exactStrings(behavior.runtime_paths, ["contract", "src"]) &&
    behavior.runtime_sha256 === expectedPublishedRuntimeSha256 &&
    release.tag === "v3.0.0" &&
    release.commit === expectedPublishedReleaseCommit &&
    release.tree === expectedPublishedReleaseTree &&
    release.release_id === 363834941 &&
    release.release_url ===
      "https://github.com/CUNY-AI-Lab/cail-client/releases/tag/v3.0.0" &&
    release.published_at === "2026-08-02T16:28:59Z" &&
    release.workflow_run_id === 30756728587 &&
    release.workflow_run_url ===
      "https://github.com/CUNY-AI-Lab/cail-client/actions/runs/30756728587" &&
    release.workflow_job_id === 91520060337 &&
    release.workflow_job_url ===
      "https://github.com/CUNY-AI-Lab/cail-client/actions/runs/30756728587/job/91520060337" &&
    release.run_status === "completed" &&
    release.run_conclusion === "success" &&
    registry.url === "https://npm.pkg.github.com" &&
    registry.api ===
      "https://api.github.com/orgs/CUNY-AI-Lab/packages/npm/cail-client/versions" &&
    registry.package_id === 13479481 &&
    registry.version_id === 1091020674 &&
    registry.version === expectedPublishedVersion &&
    registry.created_at === "2026-08-02T16:29:40Z" &&
    registry.observed_at === "2026-08-06T20:48:40Z" &&
    registry.state === "published" &&
    isValidPublishedArtifactMetadata(registry.artifact)
  );
}

function isVersionRecord(value: unknown): value is Version {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.created_at === "string" &&
    value.created_at.length > 0
  );
}

function hasUniqueExactVersion(
  versions: readonly Version[],
  expected: { id: number; name: string; created_at: string },
): boolean {
  const matches = versions.filter((version) => version.name === expected.name);
  return (
    matches.length === 1 &&
    matches[0]?.id === expected.id &&
    matches[0]?.created_at === expected.created_at
  );
}

export function isValidPublishedVersions(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(isVersionRecord)) return false;
  return (
    hasUniqueExactVersion(value, {
      id: 1091020674,
      name: expectedPublishedVersion,
      created_at: "2026-08-02T16:29:40Z",
    }) &&
    hasUniqueExactVersion(value, {
      id: 1066318244,
      name: expectedHistoricalVersion,
      created_at: "2026-07-25T17:33:30Z",
    })
  );
}

/**
 * A publication preflight proves that the package version is still absent.
 * The known 2.0.0 record is also required as a pagination/completeness anchor;
 * an empty or malformed response must never authorize a publish.
 */
export function isValidPublicationPreflight(
  value: unknown,
  packageVersion = expectedPublishedVersion,
): boolean {
  if (
    !Array.isArray(value) ||
    !value.every(isVersionRecord) ||
    !hasUniqueExactVersion(value, {
      id: 1066318244,
      name: expectedHistoricalVersion,
      created_at: "2026-07-25T17:33:30Z",
    })
  ) {
    return false;
  }
  return !value.some((version) => version.name === packageVersion);
}

function hashGitObject(type: "blob" | "tree", content: Uint8Array): Buffer {
  return createHash("sha256")
    .update(`${type} ${content.byteLength}\0`)
    .update(content)
    .digest();
}

/** Hashes a package directory with the same Git-compatible tree algorithm as the reviewed artifact gates. */
export function hashGitTree(directory: string): string {
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`artifact package root is not a directory: ${directory}`);
  }
  const entries = readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const path = join(directory, entry.name);
    const metadata = lstatSync(path);
    let mode: "100644" | "100755" | "120000" | "40000";
    let hash: Buffer;
    if (metadata.isDirectory()) {
      mode = "40000";
      hash = Buffer.from(hashGitTree(path), "hex");
    } else if (metadata.isFile()) {
      mode = metadata.mode & 0o111 ? "100755" : "100644";
      hash = hashGitObject("blob", readFileSync(path));
    } else if (metadata.isSymbolicLink()) {
      mode = "120000";
      hash = hashGitObject("blob", Buffer.from(readlinkSync(path)));
    } else {
      throw new Error(`artifact package contains unsupported entry: ${path}`);
    }
    const name = Buffer.from(entry.name);
    return {
      content: Buffer.concat([
        Buffer.from(`${mode} `),
        name,
        Buffer.from([0]),
        hash,
      ]),
      sortName: Buffer.concat([
        name,
        metadata.isDirectory() ? Buffer.from("/") : Buffer.alloc(0),
      ]),
    };
  });
  entries.sort((left, right) => Buffer.compare(left.sortName, right.sortName));
  return hashGitObject(
    "tree",
    Buffer.concat(entries.map((entry) => entry.content)),
  ).toString("hex");
}

export function artifactDigest(bytes: Uint8Array): ArtifactDigest {
  const contents = Buffer.from(bytes);
  return {
    bytes: contents.byteLength,
    sha1: createHash("sha1").update(contents).digest("hex"),
    sha256: createHash("sha256").update(contents).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
  };
}

export function isValidArtifactBytes(
  bytes: Uint8Array,
  artifact: unknown,
): artifact is PublishedArtifact {
  if (!isArtifactShape(artifact)) return false;
  const digest = artifactDigest(bytes);
  return (
    digest.bytes === artifact.bytes &&
    digest.sha1 === artifact.sha1 &&
    digest.sha256 === artifact.sha256 &&
    digest.integrity === artifact.integrity
  );
}

function archiveEntries(archivePath: string): string[] {
  const listed = spawnSync(
    "tar",
    ["-tzf", archivePath],
    {
      encoding: "utf8",
      maxBuffer: maxArtifactBytes,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (listed.status !== 0 || typeof listed.stdout !== "string") {
    throw new Error("published artifact is not a readable gzip tar archive");
  }
  const entries = listed.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const segments = entry.split("/").filter((segment) => segment.length > 0);
    if (
      isAbsolute(entry) ||
      segments.some((segment) => segment === "..") ||
      (segments.length > 0 && segments[0] !== "package")
    ) {
      throw new Error("published artifact contains an unsafe archive path");
    }
  }
  return entries;
}

export function verifyPublishedArtifactArchive(
  archivePath: string,
  artifact: PublishedArtifact,
): void {
  const bytes = readFileSync(archivePath);
  if (!isValidArtifactBytes(bytes, artifact)) {
    throw new Error(
      "published artifact bytes do not match the recorded size, SHA-1, SHA-256, or SRI",
    );
  }
  const temporary = mkdtempSync(join(tmpdir(), "cail-client-release-"));
  try {
    const entries = archiveEntries(archivePath);
    if (!entries.some((entry) => entry.startsWith("package/"))) {
      throw new Error("published artifact has no package root");
    }
    const extracted = spawnSync(
      "tar",
      ["-xzf", archivePath, "-C", temporary],
      {
        encoding: "utf8",
        maxBuffer: maxArtifactBytes,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (extracted.status !== 0) {
      throw new Error("published artifact could not be extracted");
    }
    const installedTree = hashGitTree(resolve(temporary, "package"));
    if (installedTree !== artifact.git_tree_sha256) {
      throw new Error(
        "published artifact package tree does not match the recorded Git-tree SHA-256",
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function boundedResponseBytes(response: Response): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxArtifactBytes) {
      throw new Error("published artifact response exceeds the bounded download limit");
    }
  }
  if (response.body === null) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxArtifactBytes) {
      throw new Error("published artifact response exceeds the bounded download limit");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maxArtifactBytes) {
        throw new Error("published artifact response exceeds the bounded download limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadAndVerifyPublishedArtifact(
  artifact: PublishedArtifact,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (token.length === 0) throw new Error("GH_TOKEN is required for the live artifact check");
  let response: Response;
  try {
    response = await fetchImpl(artifact.url, {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": githubApiVersion,
      },
      signal: AbortSignal.timeout(artifactRequestTimeoutMs),
    });
  } catch {
    throw new Error("published artifact download failed");
  }
  if (!response.ok) {
    throw new Error(`published artifact download returned HTTP ${response.status}`);
  }
  const bytes = await boundedResponseBytes(response);
  const temporary = mkdtempSync(join(tmpdir(), "cail-client-release-"));
  const archivePath = join(temporary, "package.tgz");
  try {
    writeFileSync(archivePath, bytes, { mode: 0o600 });
    verifyPublishedArtifactArchive(archivePath, artifact);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

type GitResult = {
  status: number | null;
  stdout: string;
};

function git(args: string[]): GitResult {
  const result = spawnSync("git", ["--no-replace-objects", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

type SourceTag = {
  commit: string;
  tree: string;
};

function localPublishedTag(): SourceTag | undefined {
  const repository = git(["rev-parse", "--is-inside-work-tree"]);
  if (repository.status !== 0 || repository.stdout.trim() !== "true") {
    // Source archives do not carry Git metadata, so their release-tag check is
    // intentionally skipped. The release workflow performs the API check.
    return undefined;
  }
  // Shallow branch checkouts may omit historical tags. They skip this local
  // assertion; the release workflow independently resolves the tag, GITHUB_SHA,
  // and live default-branch head through the GitHub contents API.
  const shallow = git(["rev-parse", "--is-shallow-repository"]);
  const commit = git(["rev-parse", "--verify", "refs/tags/v3.0.0^{commit}"]);
  const tree = git(["rev-parse", "--verify", "refs/tags/v3.0.0^{tree}"]);
  if (commit.status !== 0 || tree.status !== 0) {
    if (shallow.status === 0 && shallow.stdout.trim() === "true") {
      return undefined;
    }
    throw new Error(
      "cail-client: published source tag v3.0.0 is missing or unreadable",
    );
  }
  return {
    commit: commit.stdout.trim(),
    tree: tree.stdout.trim(),
  };
}

export function isValidPublishedSourceTag(source: SourceTag): boolean {
  return (
    source.commit === expectedPublishedReleaseCommit &&
    source.tree === expectedPublishedReleaseTree
  );
}

function versionsFromEnvironment(): Version[] {
  const versionsPath = process.env.CAIL_REGISTRY_VERSIONS_FILE;
  if (!versionsPath) {
    throw new Error(
      "cail-client: registry authority requires CAIL_REGISTRY_VERSIONS_FILE",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(versionsPath, "utf8"));
  } catch {
    throw new Error("cail-client: registry authority snapshot is unreadable");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("cail-client: registry authority snapshot is not an array");
  }
  return parsed as Version[];
}

async function main(): Promise<void> {
  const historicalAuthority = JSON.parse(
    readFileSync(historicalAuthorityPath, "utf8"),
  ) as Authority;
  const releaseAuthority = JSON.parse(
    readFileSync(releaseAuthorityPath, "utf8"),
  ) as Authority;
  const packageJson = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  if (
    !isValidHistoricalAuthority(historicalAuthority) ||
    !isValidPublishedAuthority(releaseAuthority) ||
    packageJson.name !== "@cuny-ai-lab/cail-client" ||
    packageJson.version !== expectedPublishedVersion ||
    runtimeDigest() !== expectedPublishedRuntimeSha256
  ) {
    throw new Error("cail-client: local release authority is invalid");
  }
  const sourceTag = localPublishedTag();
  if (sourceTag !== undefined && !isValidPublishedSourceTag(sourceTag)) {
    throw new Error(
      "cail-client: published source tag v3.0.0 does not match the recorded commit and tree",
    );
  }

  if (process.argv.includes("--publication-preflight")) {
    const versions = versionsFromEnvironment();
    if (!isValidPublicationPreflight(versions, String(packageJson.version))) {
      throw new Error(
        `cail-client: publication preflight blocked; package version ${String(packageJson.version)} is already published or the registry snapshot is incomplete`,
      );
    }
    return;
  }

  if (process.argv.includes("--live")) {
    const versions = versionsFromEnvironment();
    if (!isValidPublishedVersions(versions)) {
      throw new Error(
        "cail-client: published registry version authority changed or 3.0.0 is unavailable",
      );
    }
    const registry = releaseAuthority.registry;
    const artifact = registry?.artifact;
    if (!isValidPublishedArtifactMetadata(artifact)) {
      throw new Error("cail-client: published artifact authority is invalid");
    }
    const token = process.env.GH_TOKEN;
    if (!token) {
      throw new Error("cail-client: GH_TOKEN is required for the live artifact check");
    }
    await downloadAndVerifyPublishedArtifact(artifact, token);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
