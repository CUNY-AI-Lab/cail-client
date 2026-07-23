import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const nested = process.env.CAIL_DIST_DRIFT_NESTED === "1";

describe("committed dist authority", () => {
  (nested ? it.skip : it)(
    "makes the full check reject drift without rebuilding it away",
    () => {
      const temporary = mkdtempSync(
        join(tmpdir(), "cail-client-dist-drift-"),
      );
      const checkout = join(temporary, "checkout");
      try {
        cpSync(root, checkout, {
          recursive: true,
          filter(source) {
            const path = relative(root, source);
            return (
              path !== ".git" &&
              !path.startsWith(`.git${sep}`) &&
              path !== "node_modules" &&
              !path.startsWith(`node_modules${sep}`)
            );
          },
        });
        expect(existsSync(join(checkout, ".git"))).toBe(false);
        symlinkSync(
          resolve(root, "node_modules"),
          join(checkout, "node_modules"),
          "dir",
        );

        const distPath = join(checkout, "dist/index.js");
        const drift = Buffer.concat([
          readFileSync(distPath),
          Buffer.from("\n// harmless stale-dist sentinel\n"),
        ]);
        writeFileSync(distPath, drift);

        const result = spawnSync("bun", ["run", "check"], {
          cwd: checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            CAIL_DIST_DRIFT_NESTED: "1",
          },
          timeout: 120_000,
        });
        const output = (result.stdout ?? "") + (result.stderr ?? "");
        expect(result.status).not.toBe(0);
        expect(output).toContain(
          "cail-client: dist/index.js does not match source build",
        );
        expect(output).not.toContain("bun pm pack");
        expect(readFileSync(distPath).equals(drift)).toBe(true);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
