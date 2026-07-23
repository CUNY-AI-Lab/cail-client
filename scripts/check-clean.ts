const root = new URL("../", import.meta.url).pathname;
const insideWorktree = Bun.spawnSync({
  cmd: ["git", "rev-parse", "--is-inside-work-tree"],
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});

if (
  insideWorktree.exitCode !== 0 ||
  insideWorktree.stdout.toString().trim() !== "true"
) {
  console.error(
    "cail-client publication requires a clean Git checkout; source archives may run `bun run check` but cannot publish.",
  );
  process.exit(1);
}

const status = Bun.spawnSync({
  cmd: ["git", "status", "--porcelain", "--untracked-files=all"],
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
if (status.exitCode !== 0) {
  console.error("cail-client could not verify publication worktree status.");
  process.exit(1);
}
if (status.stdout.length > 0) {
  console.error("cail-client publication requires a clean Git worktree.");
  process.exit(1);
}
