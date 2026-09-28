import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BrowserNotFoundError,
  getCloakStealthArgs,
  resolveBrowser,
} from "./resolve-browser.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.CLOAKBROWSER_EXECUTABLE_PATH;
  delete process.env.CLOAKBROWSER_CACHE_DIR;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeFakeCache(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-cache-"));
  const binaryDir = path.join(dir, `chromium-${version}`);
  fs.mkdirSync(binaryDir);
  const binary = path.join(binaryDir, "chrome");
  fs.writeFileSync(binary, "#!/bin/sh\n");
  fs.chmodSync(binary, 0o755);
  return dir;
}

describe("getCloakStealthArgs", () => {
  it("includes the linux platform spoof and no-sandbox", () => {
    const args = getCloakStealthArgs();
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--fingerprint-platform=linux");
  });

  it("generates a 5-digit numeric fingerprint seed", () => {
    for (let i = 0; i < 20; i++) {
      const arg = getCloakStealthArgs().find((a) => a.startsWith("--fingerprint="));
      expect(arg).toBeDefined();
      const seed = arg!.split("=")[1];
      expect(seed).toMatch(/^\d{5}$/);
    }
  });
});

describe("resolveBrowser", () => {
  it("prefers an explicit CLOAKBROWSER_BINARY_PATH override", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-test-"));
    const binary = path.join(dir, "chrome");
    fs.writeFileSync(binary, "#!/bin/sh\n");
    fs.chmodSync(binary, 0o755);
    process.env.CLOAKBROWSER_BINARY_PATH = binary;

    const resolved = resolveBrowser();
    expect(resolved.engine).toBe("cloakbrowser");
    expect(resolved.executablePath).toBe(binary);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws when the override path does not exist (no Chrome fallback)", () => {
    process.env.CLOAKBROWSER_BINARY_PATH = "/nonexistent/cloak/chrome";
    expect(() => resolveBrowser()).toThrow(BrowserNotFoundError);
  });

  it("auto-detects a cloak cache binary in CLOAKBROWSER_CACHE_DIR", () => {
    process.env.CLOAKBROWSER_CACHE_DIR = makeFakeCache("146.0.7680.177.5");

    const resolved = resolveBrowser();
    expect(resolved.engine).toBe("cloakbrowser");
    expect(resolved.version).toBe("146.0.7680.177.5");
    expect(resolved.executablePath).toContain("chromium-146.0.7680.177.5");
  });

  it("prefers the highest cached cloak version", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-cache-"));
    for (const version of ["146.0.7680.177.5", "145.0.7632.109.2"]) {
      const binaryDir = path.join(dir, `chromium-${version}`);
      fs.mkdirSync(binaryDir);
      const binary = path.join(binaryDir, "chrome");
      fs.writeFileSync(binary, "#!/bin/sh\n");
      fs.chmodSync(binary, 0o755);
    }
    process.env.CLOAKBROWSER_CACHE_DIR = dir;

    const resolved = resolveBrowser();
    expect(resolved.version).toBe("146.0.7680.177.5");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws BrowserNotFoundError when no cloak binary exists anywhere", () => {
    process.env.CLOAKBROWSER_CACHE_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloak-empty-"),
    );
    try {
      expect(() => resolveBrowser()).toThrow(/npx cloakbrowser install/);
    } finally {
      fs.rmSync(process.env.CLOAKBROWSER_CACHE_DIR, { recursive: true, force: true });
    }
  });

  it("never resolves a stock Chrome path even when one exists on disk", () => {
    // Empty cache; /usr/bin/google-chrome may exist on the host but must be ignored.
    process.env.CLOAKBROWSER_CACHE_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "cloak-empty-"),
    );
    try {
      expect(() => resolveBrowser()).toThrow(BrowserNotFoundError);
    } finally {
      fs.rmSync(process.env.CLOAKBROWSER_CACHE_DIR, { recursive: true, force: true });
    }
  });
});
