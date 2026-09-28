import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { env } from "../env.js";
import https from "https";
import http from "http";
import extractZip from "extract-zip";

/**
 * Extract an uploaded extension archive next to the zip so the launcher's
 * validation (manifest.json at <extDir>/manifest.json) accepts it and the
 * browser actually loads it. Chrome rejects flat zips (no wrapping folder),
 * so unpack directly into the extension directory.
 */
async function extractExtensionArchive(destDir: string, zipPath: string): Promise<void> {
  try {
    await extractZip(zipPath, { dir: destDir });
    // Valid uploads put manifest.json at the zip root (possibly inside a single
    // wrapper folder — flatten that case so the launcher always finds it).
    const manifestAtRoot = fs.existsSync(path.join(destDir, "manifest.json"));
    if (!manifestAtRoot) {
      const entries = fs
        .readdirSync(destDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      if (entries.length === 1) {
        const inner = path.join(destDir, entries[0].name);
        if (fs.existsSync(path.join(inner, "manifest.json"))) {
          for (const item of fs.readdirSync(inner)) {
            fs.renameSync(path.join(inner, item), path.join(destDir, item));
          }
          fs.rmSync(inner, { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    // Not a zip (e.g. raw .crx handled elsewhere) or corrupt archive — leave the
    // file in place; the launcher will skip it with a warning.
    console.warn(
      `[extensions] Could not extract ${zipPath}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export interface ExtensionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  filePath: string;
  size: number;
}

export class ExtensionService {
  private static instance: ExtensionService | null = null;
  private basePath: string;
  private metaPath: string;

  constructor(basePath?: string) {
    this.basePath =
      basePath ??
      (env.NODE_ENV === "development"
        ? path.join(tmpdir(), "steel-extensions")
        : "/data/extensions");
    this.metaPath = path.join(this.basePath, "meta.json");
    fs.mkdirSync(this.basePath, { recursive: true });
    if (!fs.existsSync(this.metaPath)) {
      fs.writeFileSync(this.metaPath, JSON.stringify({}));
    }
  }

  static getInstance(): ExtensionService {
    if (!ExtensionService.instance) {
      ExtensionService.instance = new ExtensionService();
    }
    return ExtensionService.instance;
  }

  private readMeta(): Record<string, ExtensionMeta> {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, "utf-8"));
    } catch {
      return {};
    }
  }

  private writeMeta(meta: Record<string, ExtensionMeta>) {
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
  }

  list(): { count: number; extensions: Omit<ExtensionMeta, "filePath" | "size">[] } {
    const meta = this.readMeta();
    const extensions = Object.values(meta).map(({ id, name, createdAt, updatedAt }) => ({
      id,
      name,
      createdAt,
      updatedAt,
    }));
    return { count: extensions.length, extensions };
  }

  get(id: string): ExtensionMeta | null {
    const meta = this.readMeta();
    return meta[id] ?? null;
  }

  getFilePath(id: string): string | null {
    const ext = this.get(id);
    return ext?.filePath ?? null;
  }

  async createFromFile(
    fileStream: Readable,
    originalName?: string,
  ): Promise<Omit<ExtensionMeta, "filePath" | "size">> {
    const id = randomUUID();
    const destDir = path.join(this.basePath, id);
    fs.mkdirSync(destDir, { recursive: true });

    const zipPath = path.join(destDir, "extension.zip");
    const writeStream = fs.createWriteStream(zipPath);
    await pipeline(fileStream, writeStream);
    await extractExtensionArchive(destDir, zipPath);

    const name = originalName?.replace(/\.(zip|crx)$/i, "") || `extension-${id.slice(0, 8)}`;

    const stats = fs.statSync(zipPath);
    const now = new Date().toISOString();
    const meta = this.readMeta();
    meta[id] = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      filePath: zipPath,
      size: stats.size,
    };
    this.writeMeta(meta);

    return { id, name, createdAt: now, updatedAt: now };
  }

  async createFromUrl(url: string): Promise<Omit<ExtensionMeta, "filePath" | "size">> {
    const stream = await this.fetchUrl(url);
    const urlName = new URL(url).pathname.split("/").pop() || undefined;
    return this.createFromFile(stream, urlName);
  }

  async updateFromFile(
    id: string,
    fileStream: Readable,
    originalName?: string,
  ): Promise<Omit<ExtensionMeta, "filePath" | "size">> {
    const existing = this.get(id);
    if (!existing) throw new Error("Extension not found");

    const destDir = path.join(this.basePath, id);
    fs.mkdirSync(destDir, { recursive: true });
    const zipPath = path.join(destDir, "extension.zip");
    const writeStream = fs.createWriteStream(zipPath);
    await pipeline(fileStream, writeStream);
    await extractExtensionArchive(destDir, zipPath);

    let name = existing.name;
    if (originalName) {
      name = originalName.replace(/\.(zip|crx)$/i, "");
    }

    const stats = fs.statSync(zipPath);
    const now = new Date().toISOString();
    const meta = this.readMeta();
    meta[id] = {
      ...existing,
      name,
      updatedAt: now,
      filePath: zipPath,
      size: stats.size,
    };
    this.writeMeta(meta);
    return { id, name, createdAt: existing.createdAt, updatedAt: now };
  }

  async updateFromUrl(id: string, url: string): Promise<Omit<ExtensionMeta, "filePath" | "size">> {
    const stream = await this.fetchUrl(url);
    const urlName = new URL(url).pathname.split("/").pop() || undefined;
    return this.updateFromFile(id, stream, urlName);
  }

  delete(id: string): boolean {
    const meta = this.readMeta();
    if (!meta[id]) return false;
    const destDir = path.join(this.basePath, id);
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete meta[id];
    this.writeMeta(meta);
    return true;
  }

  deleteAll(): number {
    const meta = this.readMeta();
    const count = Object.keys(meta).length;
    for (const id of Object.keys(meta)) {
      const destDir = path.join(this.basePath, id);
      try {
        fs.rmSync(destDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.writeMeta({});
    return count;
  }

  private fetchUrl(url: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      client
        .get(url, { headers: { "User-Agent": "Steel-Browser/1.0" } }, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            this.fetchUrl(res.headers.location).then(resolve).catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
            return;
          }
          resolve(res);
        })
        .on("error", reject);
    });
  }
}
