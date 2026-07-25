import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function git(args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "--no-replace-objects", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    console.error("cail-client could not verify publication checkout.");
    process.exit(1);
  }
  return result.stdout.toString();
}

if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
  console.error(
    "cail-client publication requires a clean Git checkout; source archives may run `bun run check` but cannot publish.",
  );
  process.exit(1);
}
if (git(["for-each-ref", "--format=%(refname)", "refs/replace"]).trim()) {
  console.error("cail-client publication rejects Git replacement refs.");
  process.exit(1);
}
const grafts = git(["rev-parse", "--git-path", "info/grafts"]).trim();
if (grafts && existsSync(resolve(root, grafts))) {
  console.error("cail-client publication rejects legacy Git grafts.");
  process.exit(1);
}
if (git(["status", "--porcelain", "--untracked-files=all"]).length > 0) {
  console.error("cail-client publication requires a clean Git worktree.");
  process.exit(1);
}
for (const line of git(["ls-files", "-v"]).split("\n")) {
  if (line && !line.startsWith("H ")) {
    console.error(
      "cail-client publication rejects nonordinary Git index flags.",
    );
    process.exit(1);
  }
}
