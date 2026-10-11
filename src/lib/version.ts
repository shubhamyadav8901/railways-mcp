import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package version from package.json, resolved relative to this module so it
 * works both from `src/lib/` (dev / vitest) and `dist/src/lib/` (Docker / npm start).
 */
export function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../package.json", "../../../package.json"] as const) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), "utf8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  throw new Error("could not read version from package.json");
}
