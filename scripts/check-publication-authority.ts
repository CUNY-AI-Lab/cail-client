import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedSha256 =
  "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215";
const acceptedLogCommit =
  "cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98";
const acceptedLogTree =
  "618c4bdfae0effadbe23cfd6c4dfb1fcf6440697";

type RegistryReceipt = {
  schema_version?: unknown;
  package?: { name?: unknown; version?: unknown };
  registry?: { url?: unknown; package_version_id?: unknown };
  artifact?: { bytes?: unknown; sha256?: unknown };
  independent_review?: {
    accepted_commit?: unknown;
    accepted_tree?: unknown;
  };
};

export function isValidRegistryReceipt(
  receipt: RegistryReceipt,
): boolean {
  return (
    receipt.schema_version === 1 &&
    receipt.package?.name === "@cuny-ai-lab/cail-log" &&
    receipt.package?.version === "0.6.0" &&
    receipt.registry?.url === "https://npm.pkg.github.com" &&
    typeof receipt.registry?.package_version_id === "number" &&
    Number.isSafeInteger(receipt.registry.package_version_id) &&
    receipt.registry.package_version_id > 0 &&
    receipt.artifact?.bytes === 50269 &&
    receipt.artifact?.sha256 === expectedSha256 &&
    receipt.independent_review?.accepted_commit === acceptedLogCommit &&
    receipt.independent_review?.accepted_tree === acceptedLogTree
  );
}

function fail(reason: string): never {
  console.error(`cail-client publication blocked: ${reason}`);
  process.exit(1);
}

function main(): void {
  const authorityPath = new URL(
    "../vendor/cail-log-0.6.0.authority.json",
    import.meta.url,
  );
  const artifactPath = new URL(
    "../vendor/cuny-ai-lab-cail-log-0.6.0.tgz",
    import.meta.url,
  );
  const receiptPath = new URL(
    "../vendor/cail-log-0.6.0.registry-receipt.json",
    import.meta.url,
  );
  const authority = JSON.parse(
    readFileSync(authorityPath, "utf8"),
  ) as {
    package?: { name?: unknown; version?: unknown };
    source?: { commit?: unknown; tree?: unknown };
    artifact?: { bytes?: unknown; sha256?: unknown };
    registry?: { required_receipt?: unknown };
    client_publication?: { reason?: unknown };
  };
  const artifact = readFileSync(artifactPath);
  const artifactSha256 = createHash("sha256")
    .update(artifact)
    .digest("hex");
  if (
    authority.package?.name !== "@cuny-ai-lab/cail-log" ||
    authority.package?.version !== "0.6.0" ||
    authority.source?.commit !== acceptedLogCommit ||
    authority.source?.tree !== acceptedLogTree ||
    authority.artifact?.bytes !== 50269 ||
    authority.artifact?.sha256 !== expectedSha256 ||
    statSync(artifactPath).size !== 50269 ||
    artifactSha256 !== expectedSha256 ||
    authority.registry?.required_receipt !==
      "vendor/cail-log-0.6.0.registry-receipt.json"
  ) {
    fail("the reviewed source artifact authority is invalid.");
  }
  if (!existsSync(receiptPath)) {
    const reason =
      typeof authority.client_publication?.reason === "string"
        ? authority.client_publication.reason
        : "The registry artifact is unavailable.";
    fail(`${reason} A reviewed immutable registry receipt is required.`);
  }

  const receipt = JSON.parse(
    readFileSync(receiptPath, "utf8"),
  ) as RegistryReceipt;
  if (!isValidRegistryReceipt(receipt)) {
    fail("the immutable registry receipt is invalid.");
  }
}

const invokedPath = process.argv[1]
  ? resolve(process.argv[1])
  : undefined;
if (
  invokedPath !== undefined &&
  invokedPath === fileURLToPath(import.meta.url)
) {
  main();
}
