import fs from "fs";
import os from "os";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { env } from "../env.js";

/**
 * Resolve the extension directories to load into the browser.
 *
 * Every extension present in the extensions directory is loaded by default on
 * every launch — users never need to pass anything to enable them. Any extra
 * names requested by the caller must also exist in that directory.
 */
export async function getExtensionPaths(extensionNames: string[] = []): Promise<string[]> {
  // Primary: the persistent extension store the Extensions API uploads into
  // (/data/extensions in production). Fallback: the bundled api/extensions
  // directory from the original layout. STEEL_EXTENSIONS_DIR overrides both.
  const candidateDirs = [
    process.env.STEEL_EXTENSIONS_DIR,
    env.NODE_ENV === "development" ? path.join(os.tmpdir(), "steel-extensions") : "/data/extensions",
    path.join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions"),
  ].filter(Boolean) as string[];

  let extensionsDir: string | null = null;
  for (const dir of candidateDirs) {
    try {
      await fs.promises.access(dir);
      extensionsDir = dir;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!extensionsDir) {
    console.warn("Extensions directory does not exist");
    return [];
  }

  const allExtensions = (await fs.promises.readdir(extensionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Load everything available by default, plus any requested names that exist.
  const loadSet = new Set<string>([...allExtensions, ...extensionNames]);
  const candidatePaths = Array.from(loadSet)
    .filter((name) => allExtensions.includes(name))
    .map((dir) => path.join(extensionsDir, dir));

  const validationResults = await Promise.all(
    candidatePaths.map(async (fullPath) => {
      try {
        // A valid extension directory contains a manifest.json
        await fs.promises.access(path.join(fullPath, "manifest.json"));
        return { path: fullPath, valid: true };
      } catch {
        console.warn(`Extension directory ${fullPath} has no manifest.json; skipping`);
        return { path: fullPath, valid: false };
      }
    }),
  );

  return validationResults.filter((result) => result.valid).map((result) => result.path);
}
