import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const result = spawnSync(
  "sh",
  [
    "-c",
    "git ls-files -z | xargs -0 sh -c 'for file; do if [ -f \"$file\" ]; then if grep -nH \"[[:blank:]]$\" \"$file\"; then :; else code=$?; if [ \"$code\" -gt 1 ]; then exit \"$code\"; fi; fi; fi; done' sh",
  ],
  {
    cwd: resolve(import.meta.dir, ".."),
    encoding: "utf8",
  },
);

if (result.status === 0 && result.stdout.length > 0) {
  throw new Error(`cail-client: tracked files contain trailing whitespace:\n${result.stdout}`);
}

if (result.status !== 0) {
  throw new Error(`cail-client: trailing-whitespace check failed:\n${result.stderr}`);
}
