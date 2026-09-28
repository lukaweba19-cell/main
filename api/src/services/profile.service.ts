import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { env } from "../env.js";

export interface Dimensions {
  width: number;
  height: number;
}

export interface ProfileMeta {
  id: string;
  projectId?: string | null;
  status: string;
  dimensions?: Dimensions | null;
  extensionIds?: string[];
  fingerprint?: Record<string, unknown> | null;
  credentialsConfig?: Record<string, unknown> | null;
  userDataDir?: string | null; // path to stored zip
  userAgent?: string | null;
  proxyUrl?: string | null;
  useProxy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ProfileService {
  private static instance: ProfileService | null = null;
  private basePath: string;
  private metaPath: string;

  constructor(basePath?: string) {
    this.basePath =
      basePath ??
      (env.NODE_ENV === "development" ? path.join(tmpdir(), "steel-profiles") : "/data/profiles");
    this.metaPath = path.join(this.basePath, "meta.json");
    fs.mkdirSync(this.basePath, { recursive: true });
    if (!fs.existsSync(this.metaPath)) {
      fs.writeFileSync(this.metaPath, JSON.stringify({}));
    }
  }

  static getInstance(): ProfileService {
    if (!ProfileService.instance) {
      ProfileService.instance = new ProfileService();
    }
    return ProfileService.instance;
  }

  private readMeta(): Record<string, ProfileMeta> {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, "utf-8"));
    } catch {
      return {};
    }
  }

  private writeMeta(meta: Record<string, ProfileMeta>) {
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
  }

  private toPublic(p: ProfileMeta) {
    const {
      userDataDir,
      fingerprint,
      credentialsConfig,
      projectId,
      proxyUrl,
      useProxy,
      userAgent,
      dimensions,
      ...rest
    } = p;
    return {
      ...rest,
      projectId: projectId || undefined,
      dimensions: dimensions || undefined,
      extensionIds: p.extensionIds || [],
      fingerprint: fingerprint || undefined,
      credentialsConfig: credentialsConfig || undefined,
      userDataDir: userDataDir ? true : undefined,
      userAgent: userAgent || undefined,
      proxyUrl: proxyUrl || undefined,
      useProxy: useProxy || undefined,
    };
  }

  list(projectId?: string): { count: number; profiles: ReturnType<ProfileService["toPublic"]>[] } {
    const meta = this.readMeta();
    let profiles = Object.values(meta);
    if (projectId) {
      profiles = profiles.filter((p) => p.projectId === projectId);
    }
    return {
      count: profiles.length,
      profiles: profiles.map((p) => this.toPublic(p)),
    };
  }

  get(id: string, projectId?: string): ProfileMeta | null {
    const meta = this.readMeta();
    const p = meta[id];
    if (!p) return null;
    if (projectId && p.projectId && p.projectId !== projectId) return null;
    return p;
  }

  async create(opts: {
    userDataDirStream?: Readable;
    dimensions?: Dimensions;
    projectId?: string;
    proxyUrl?: string;
    useProxy?: string;
    userAgent?: string;
  }): Promise<ReturnType<ProfileService["toPublic"]>> {
    const id = randomUUID();
    const destDir = path.join(this.basePath, id);
    fs.mkdirSync(destDir, { recursive: true });

    let userDataDirPath: string | null = null;
    if (opts.userDataDirStream) {
      userDataDirPath = path.join(destDir, "userDataDir.zip");
      const writeStream = fs.createWriteStream(userDataDirPath);
      await pipeline(opts.userDataDirStream, writeStream);
    }

    const now = new Date().toISOString();
    const profile: ProfileMeta = {
      id,
      projectId: opts.projectId || undefined,
      status: "READY",
      dimensions: opts.dimensions || undefined,
      extensionIds: [],
      fingerprint: undefined,
      credentialsConfig: undefined,
      userDataDir: userDataDirPath,
      userAgent: opts.userAgent || undefined,
      proxyUrl: opts.proxyUrl || undefined,
      useProxy: opts.useProxy || undefined,
      createdAt: now,
      updatedAt: now,
    };

    const meta = this.readMeta();
    meta[id] = profile;
    this.writeMeta(meta);
    return this.toPublic(profile);
  }

  async update(
    id: string,
    opts: {
      userDataDirStream?: Readable;
      dimensions?: Dimensions;
      projectId?: string;
      proxyUrl?: string;
      useProxy?: string;
      userAgent?: string;
    },
    projectIdFilter?: string,
  ): Promise<ReturnType<ProfileService["toPublic"]>> {
    const existing = this.get(id, projectIdFilter);
    if (!existing) throw new Error("Profile not found");

    const destDir = path.join(this.basePath, id);
    fs.mkdirSync(destDir, { recursive: true });

    let userDataDirPath = existing.userDataDir;
    if (opts.userDataDirStream) {
      userDataDirPath = path.join(destDir, "userDataDir.zip");
      const writeStream = fs.createWriteStream(userDataDirPath);
      await pipeline(opts.userDataDirStream, writeStream);
    }

    const now = new Date().toISOString();
    const updated: ProfileMeta = {
      ...existing,
      dimensions: opts.dimensions !== undefined ? opts.dimensions : existing.dimensions,
      projectId: opts.projectId !== undefined ? opts.projectId : existing.projectId,
      proxyUrl: opts.proxyUrl !== undefined ? opts.proxyUrl : existing.proxyUrl,
      useProxy: opts.useProxy !== undefined ? opts.useProxy : existing.useProxy,
      userAgent: opts.userAgent !== undefined ? opts.userAgent : existing.userAgent,
      userDataDir: userDataDirPath,
      updatedAt: now,
    };

    const meta = this.readMeta();
    meta[id] = updated;
    this.writeMeta(meta);
    return this.toPublic(updated);
  }
}
