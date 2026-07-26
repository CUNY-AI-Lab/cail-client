import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isValidRegistryReceipt } from "../scripts/check-publication-authority.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  files?: string[];
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
const publishWorkflow = readFileSync(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const readme = readFileSync(
  new URL("../README.md", import.meta.url),
  "utf8",
);
const npmrc = readFileSync(
  new URL("../.npmrc", import.meta.url),
  "utf8",
);
const cailLogArtifact = fileURLToPath(
  new URL(
    "../vendor/cuny-ai-lab-cail-log-0.6.0.tgz",
    import.meta.url,
  ),
);
const cailLogAuthority = JSON.parse(
  readFileSync(
    new URL("../vendor/cail-log-0.6.0.authority.json", import.meta.url),
    "utf8",
  ),
) as {
  package: { name: string; version: string };
  source: { commit: string; tree: string };
  artifact: { path: string; bytes: number; sha256: string };
  registry: {
    url: string;
    state: string;
    observed_versions: string[];
    required_receipt: string;
  };
  client_publication: { state: string; reason: string };
};

const CHECKOUT_ACTION =
  "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd";
const SETUP_BUN_ACTION =
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const CAIL_LOG_SHA256 =
  "8689422456eb4b7c672538ba91efb7606e9287df473a99a91ee2a60b5f9ba215";
const RETRACTED_CAIL_LOG_SHA256 = [
  "7db8a69e617f08b6fb0ff6ba432174c8",
  "34b278ada239cd9cfd417e6cec85e401",
].join("");
const CAIL_LOG_FILES = [
  "package/DESIGN.md",
  "package/LICENSE",
  "package/README.md",
  "package/contract/operational-event-v2.json",
  "package/dist/analytics-engine.d.ts",
  "package/dist/analytics-engine.d.ts.map",
  "package/dist/analytics-engine.js",
  "package/dist/correlation.d.ts",
  "package/dist/correlation.d.ts.map",
  "package/dist/correlation.js",
  "package/dist/event-provenance.d.ts",
  "package/dist/event-provenance.d.ts.map",
  "package/dist/event-provenance.js",
  "package/dist/index.d.ts",
  "package/dist/index.d.ts.map",
  "package/dist/index.js",
  "package/dist/logger.d.ts",
  "package/dist/logger.d.ts.map",
  "package/dist/logger.js",
  "package/dist/schema.d.ts",
  "package/dist/schema.d.ts.map",
  "package/dist/schema.js",
  "package/dist/secret-shape.d.ts",
  "package/dist/secret-shape.d.ts.map",
  "package/dist/secret-shape.js",
  "package/dist/sensitive.d.ts",
  "package/dist/sensitive.d.ts.map",
  "package/dist/sensitive.js",
  "package/package.json",
  "package/src/analytics-engine.ts",
  "package/src/correlation.ts",
  "package/src/event-provenance.ts",
  "package/src/index.ts",
  "package/src/logger.ts",
  "package/src/schema.ts",
  "package/src/secret-shape.ts",
  "package/src/sensitive.ts",
].sort();

async function actualLoopbackPublishAuthorization(): Promise<string[]> {
  const temporary = mkdtempSync(
    join(tmpdir(), "cail-client-publish-auth-"),
  );
  const packageDirectory = join(temporary, "package");
  const publishDirectory = join(temporary, "publish");
  const homeDirectory = join(temporary, "home");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization ?? "");
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("loopback publish server did not expose a TCP port");
    }
    const registry = `http://127.0.0.1:${address.port}`;
    mkdirSync(packageDirectory);
    mkdirSync(publishDirectory);
    writeFileSync(
      join(packageDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "@cuny-ai-lab/cail-client-publish-auth-probe",
          version: "0.0.0",
          type: "module",
          files: ["index.js"],
          publishConfig: {
            access: "restricted",
            registry,
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(packageDirectory, "index.js"), "export {};\n");
    writeFileSync(
      join(packageDirectory, ".npmrc"),
      [`@cuny-ai-lab:registry=${registry}`, ""].join("\n"),
    );
    // Keep every alternate credential/configuration input absent. The
    // workflow's Bun-native token must be the only possible authority.
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDirectory,
      XDG_CONFIG_HOME: join(temporary, "xdg"),
      NPM_CONFIG_TOKEN: "workflow-loopback-token",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    for (const name of [
      "NODE_AUTH_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "npm_token",
      "npm_config_token",
      "NPM_CONFIG_USERCONFIG",
      "npm_config_userconfig",
      "NPM_CONFIG_REGISTRY",
      "npm_config_registry",
      "BUN_CONFIG_TOKEN",
      "BUN_CONFIG_REGISTRY",
    ]) {
      delete environment[name];
    }

    const packed = spawnSync(
      "bun",
      [
        "pm",
        "pack",
        "--destination",
        publishDirectory,
        "--ignore-scripts",
      ],
      {
        cwd: packageDirectory,
        encoding: "utf8",
        env: environment,
      },
    );
    expect(
      packed.status,
      `${packed.stdout ?? ""}${packed.stderr ?? ""}`,
    ).toBe(0);
    const tarballs = readdirSync(publishDirectory).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    expect(tarballs).toHaveLength(1);
    copyFileSync(
      join(packageDirectory, "package.json"),
      join(publishDirectory, "package.json"),
    );

    const result = await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolvePublish, rejectPublish) => {
      const child = spawn(
        "bun",
        [
          "publish",
          "--registry",
          registry,
          join(publishDirectory, tarballs[0]!),
        ],
        {
          cwd: publishDirectory,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 30_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPublish(error);
      });
      child.once("close", (status) => {
        clearTimeout(timeout);
        resolvePublish({ status, stdout, stderr });
      });
    });
    expect(
      result.status,
      `${result.stdout}${result.stderr}`,
    ).toBe(0);
    return requests;
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe("release and CI boundary", () => {
  it("pins reviewed CI actions and prevents checkout credential persistence", () => {
    expect(ci).toContain(`uses: ${CHECKOUT_ACTION}`);
    expect(ci).toContain(`uses: ${SETUP_BUN_ACTION}`);
    expect(ci).toMatch(/persist-credentials:\s*false/);
    expect(ci).not.toMatch(/uses:\s*actions\/checkout@v\d/);
    expect(ci).not.toMatch(/uses:\s*oven-sh\/setup-bun@v\d/);
  });

  it("uses a depth-one checkout and needs no package credential", () => {
    expect(ci).toMatch(/fetch-depth:\s*1/);
    expect(ci).not.toContain("NODE_AUTH_TOKEN");
    expect(ci).toContain(
      "run: bun install --frozen-lockfile --ignore-scripts",
    );
  });

  it("uses Bun's native publish token without checkout credential writes", () => {
    expect(publishWorkflow).toContain(
      "NPM_CONFIG_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    );
    expect(publishWorkflow).not.toContain("NODE_AUTH_TOKEN");
    expect(publishWorkflow).not.toContain("NPM_CONFIG_USERCONFIG");
    expect(publishWorkflow).not.toMatch(/>\s*\.npmrc/);
    expect(publishWorkflow).toContain("bun run prepublishOnly");
    expect(publishWorkflow).toContain(
      'bun pm pack --destination "$PUBLISH_DIRECTORY" --ignore-scripts',
    );
    expect(publishWorkflow).toContain(
      'cp package.json "$PUBLISH_DIRECTORY/package.json"',
    );
    expect(publishWorkflow).toContain('cd "$PUBLISH_DIRECTORY"');
    expect(publishWorkflow).toContain(
      "--registry=https://npm.pkg.github.com",
    );

    // Hermetic: bun resolves publish credentials from an npmrc, so without one
    // this asserted whatever the developer happened to be logged into and failed
    // in CI, where the install step removes .npmrc before the tests run. A
    // placeholder credential in a temporary userconfig keeps the dry run
    // self-contained; the token actually reaching the registry is proven
    // separately by the loopback publish test below.
    const publishHome = mkdtempSync(join(tmpdir(), "cail-client-publish-"));
    writeFileSync(
      join(publishHome, ".npmrc"),
      "@cuny-ai-lab:registry=https://npm.pkg.github.com\n" +
        "//npm.pkg.github.com/:_authToken=workflow-dry-run-placeholder\n",
      { mode: 0o600 },
    );
    const result = spawnSync(
      "bun",
      ["publish", "--dry-run", "--ignore-scripts"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_CONFIG_TOKEN: "workflow-dry-run-placeholder",
          // bun does not read NPM_CONFIG_USERCONFIG; $HOME/.npmrc is what it
          // consults, which is why the publish workflow writes there too.
          HOME: publishHome,
        },
        timeout: 120_000,
      },
    );
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(result.status).toBe(0);
    expect(output).toContain(
      "+ @cuny-ai-lab/cail-client@2.0.1 (dry-run)",
    );
  });

  it("sends the workflow token in an actual hermetic publish request", async () => {
    const authorizations = await actualLoopbackPublishAuthorization();
    expect(authorizations).toEqual([
      "Bearer workflow-loopback-token",
    ]);
    expect(npmrc).toBe(
      "@cuny-ai-lab:registry=https://npm.pkg.github.com\n",
    );
  });

  it("runs hermetic local gates before checking publication authority", () => {
    expect(packageJson.packageManager).toBe("bun@1.3.5");
    expect(packageJson.scripts?.["check"]).toContain("bun run check:format");
    expect(packageJson.scripts?.["check"]).toContain("bun run typecheck");
    expect(packageJson.scripts?.["check"]).toContain("bun run test");
    expect(packageJson.scripts?.["check"]).toContain("bun run check:package");
    expect(packageJson.scripts?.["check"]).toContain("bun run check:dist");
    expect(
      packageJson.scripts?.["check"]?.indexOf("bun run check:dist"),
    ).toBeLessThan(
      packageJson.scripts?.["check"]?.indexOf("bun run check:package") ??
        -1,
    );
    expect(packageJson.scripts?.["check:format"]).toBe(
      "bun scripts/check-format.ts",
    );
    expect(packageJson.scripts?.["check:dist"]).toBe(
      "bun scripts/check-dist.ts",
    );
    expect(packageJson.scripts?.["check:package"]).toBe(
      "bun pm pack --dry-run --ignore-scripts",
    );
    expect(packageJson.scripts?.["check:clean"]).toBe(
      "bun scripts/check-clean.ts",
    );
    expect(packageJson.scripts?.["prepublishOnly"]).toContain(
      "bun run check:clean",
    );
    expect(packageJson.scripts?.["prepublishOnly"]).toContain(
      "bun run check:publication-authority",
    );
  });

  it("locks source tests to the reviewed in-repo cail-log artifact", () => {
    expect(packageJson.dependencies?.["@cuny-ai-lab/cail-log"]).toBe("0.6.0");
    expect(packageJson.files).not.toContain("vendor");
    expect(bunLock).toContain('"@cuny-ai-lab/cail-log": "0.6.0"');
    expect(bunLock).toContain(
      "@cuny-ai-lab/cail-log@vendor/cuny-ai-lab-cail-log-0.6.0.tgz",
    );
    expect(bunLock).not.toContain("file:../");
    expect(bunLock).not.toContain("cail-log-review-final-hardening");
    expect(bunLock).not.toContain("@cuny-ai-lab/cail-log@0.4.0");
    expect(cailLogAuthority).toMatchObject({
      package: {
        name: "@cuny-ai-lab/cail-log",
        version: "0.6.0",
      },
      source: {
        commit: "cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98",
        tree: "618c4bdfae0effadbe23cfd6c4dfb1fcf6440697",
      },
      artifact: {
        path: "vendor/cuny-ai-lab-cail-log-0.6.0.tgz",
        bytes: 50269,
        sha256: CAIL_LOG_SHA256,
      },
    });
  });

  it("verifies artifact bytes, file list, exports, and installed content", () => {
    const artifact = readFileSync(cailLogArtifact);
    const artifactSha256 = createHash("sha256")
      .update(artifact)
      .digest("hex");
    expect(statSync(cailLogArtifact).size).toBe(50269);
    expect(artifactSha256).toBe(CAIL_LOG_SHA256);
    expect(artifactSha256).not.toBe(RETRACTED_CAIL_LOG_SHA256);

    const files = execFileSync("tar", ["-tzf", cailLogArtifact], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .sort();
    expect(files).toEqual(CAIL_LOG_FILES);

    const packedPackageJson = JSON.parse(
      execFileSync(
        "tar",
        ["-xOf", cailLogArtifact, "package/package.json"],
        { encoding: "utf8" },
      ),
    ) as {
      name: string;
      version: string;
      exports: Record<string, unknown>;
    };
    expect(packedPackageJson.name).toBe("@cuny-ai-lab/cail-log");
    expect(packedPackageJson.version).toBe("0.6.0");
    expect(packedPackageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
      "./contract/operational-event-v2.json":
        "./contract/operational-event-v2.json",
    });

    for (const entry of CAIL_LOG_FILES) {
      const packed = execFileSync("tar", [
        "-xOf",
        cailLogArtifact,
        entry,
      ]);
      const installed = readFileSync(
        resolve(
          root,
          "node_modules/@cuny-ai-lab/cail-log",
          entry.slice("package/".length),
        ),
      );
      expect(installed.equals(packed), entry).toBe(true);
    }
  });

  it("fails publication closed when the reviewed registry receipt is absent", () => {
    // cail-log 0.6.0 is now in the registry, so the receipt exists and the
    // authority no longer describes publication as blocked. Fail-closed is
    // therefore proved by removing the receipt rather than by this repository
    // happening not to have one — which also lets the passing direction be
    // asserted, so the gate is tested both ways instead of only one.
    expect(cailLogAuthority.registry).toEqual({
      url: "https://npm.pkg.github.com",
      state: "available",
      observed_versions: ["0.4.0", "0.6.0"],
      required_receipt: "vendor/cail-log-0.6.0.registry-receipt.json",
    });
    expect(cailLogAuthority.client_publication.state).toBe("unblocked");

    const receiptPath = new URL(
      "../vendor/cail-log-0.6.0.registry-receipt.json",
      import.meta.url,
    );
    expect(existsSync(receiptPath)).toBe(true);

    const runGate = () =>
      spawnSync("bun", ["run", "check:publication-authority"], {
        cwd: root,
        encoding: "utf8",
      });

    expect(runGate().status).toBe(0);

    const saved = readFileSync(receiptPath);
    rmSync(receiptPath);
    try {
      const blocked = runGate();
      expect(blocked.status).toBe(1);
      const output = (blocked.stdout ?? "") + (blocked.stderr ?? "");
      expect(output).toContain("cail-client publication blocked");
      expect(output).toContain("immutable registry receipt is required");
      expect(output).not.toContain(RETRACTED_CAIL_LOG_SHA256);
    } finally {
      writeFileSync(receiptPath, saved);
    }
    expect(runGate().status).toBe(0);
  });

  it("rejects forged or inconsistent registry receipts", () => {
    const receipt = {
      schema_version: 1,
      package: {
        name: "@cuny-ai-lab/cail-log",
        version: "0.6.0",
      },
      registry: {
        url: "https://npm.pkg.github.com",
        package_version_id: 1045860969,
      },
      artifact: {
        bytes: 50269,
        sha256: CAIL_LOG_SHA256,
      },
      independent_review: {
        accepted_commit:
          "cb6ffc0cfd4cb544639cbf288ff6eb24c7027e98",
        accepted_tree:
          "618c4bdfae0effadbe23cfd6c4dfb1fcf6440697",
      },
    };
    expect(isValidRegistryReceipt(receipt)).toBe(true);
    expect(
      isValidRegistryReceipt({
        ...receipt,
        registry: { ...receipt.registry, package_version_id: 0 },
      }),
    ).toBe(false);
    expect(
      isValidRegistryReceipt({
        ...receipt,
        artifact: { ...receipt.artifact, sha256: "0".repeat(64) },
      }),
    ).toBe(false);
    expect(
      isValidRegistryReceipt({
        ...receipt,
        independent_review: {
          ...receipt.independent_review,
          accepted_commit: "0".repeat(40),
        },
      }),
    ).toBe(false);
    expect(
      isValidRegistryReceipt({
        ...receipt,
        independent_review: {
          ...receipt.independent_review,
          accepted_tree: "0".repeat(40),
        },
      }),
    ).toBe(false);
  });

  it("documents Bun-native GitHub Packages publishing only", () => {
    expect(readme).toContain("bun publish --dry-run");
    expect(readme).toContain("bun publish");
    expect(readme).toContain("does not claim it");
    expect(readme).toContain("2.0.1 was absent");
    expect(readme).not.toContain("npm publish");
    expect(readme).not.toMatch(/Bun .*cannot authenticate/i);
  });
});
