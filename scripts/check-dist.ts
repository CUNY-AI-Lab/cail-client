import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const expected = resolve(root, "dist");
const temporary = mkdtempSync(join(tmpdir(), "cail-client-dist-"));

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

function comparableContents(path: string): string | Buffer {
  const contents = readFileSync(path);
  if (!path.endsWith(".map")) return contents;
  const map = JSON.parse(contents.toString("utf8")) as {
    sources?: string[];
  };
  if (map.sources !== undefined) {
    map.sources = map.sources.map((source) =>
      source.replace(/^.*(?:^|\/)src\//, "src/"),
    );
  }
  return JSON.stringify(map);
}

try {
  const build = Bun.spawnSync({
    cmd: [
      resolve(root, "node_modules/.bin/tsc"),
      "-p",
      resolve(root, "tsconfig.build.json"),
      "--outDir",
      temporary,
    ],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) process.exit(build.exitCode);

  const expectedFiles = filesBelow(expected).map((file) =>
    relative(expected, file),
  );
  const actualFiles = filesBelow(temporary).map((file) =>
    relative(temporary, file),
  );
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error("cail-client: dist file list does not match source build");
  }
  for (const file of expectedFiles) {
    const expectedContents = comparableContents(resolve(expected, file));
    const actualContents = comparableContents(resolve(temporary, file));
    const matches =
      typeof expectedContents === "string"
        ? expectedContents === actualContents
        : Buffer.isBuffer(actualContents) &&
          expectedContents.equals(actualContents);
    if (!matches) {
      throw new Error(`cail-client: dist/${file} does not match source build`);
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
