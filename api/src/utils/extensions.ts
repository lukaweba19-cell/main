import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Resolve the extension directories to load into the browser.
 *
 * Every extension present in the extensions directory is loaded by default on
 * every launch — users never need to pass anything to enable them. Any extra
 * names requested by the caller must also exist in that directory.
 */
export async function getExtensionPaths(extensionNames: string[] = []): Promise<string[]> {
  const extensionsDir = path.join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "extensions",
  );

  try {
    await fs.promises.access(extensionsDir);
  } catch {
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
