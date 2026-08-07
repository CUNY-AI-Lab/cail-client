import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const textAuthorities = [
  ".github",
  ".gitignore",
  ".npmrc",
  "LICENSE",
  "README.md",
  "bun.lock",
  "contract",
  "dist",
  "package.json",
  "scripts",
  "src",
  "test",
  "tsconfig.build.json",
  "tsconfig.json",
  "tsconfig.test.json",
  "vendor/cail-log-0.6.0.authority.json",
  "vendor/cail-client-2.0.1.release-authority.json",
  "vendor/cail-client-3.0.0.release-authority.json",
  "vendor/cail-client-3.0.1.release-authority.json",
  "vendor/cail-client-3.0.2.release-authority.json",
  "vitest.config.ts",
];
const failures: string[] = [];

function scan(path: string): void {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory() || entry.isFile()) scan(child);
    }
    return;
  }
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (/[ \t]+$/.test(line)) {
      failures.push(`${relative(root, path)}:${index + 1}`);
    }
  }
}

for (const authority of textAuthorities) {
  scan(resolve(root, authority));
}
if (failures.length > 0) {
  throw new Error(
    `cail-client: tracked text contains trailing whitespace:\n${failures.join("\n")}`,
  );
}
