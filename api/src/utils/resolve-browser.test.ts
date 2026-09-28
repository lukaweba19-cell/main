import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getCloakStealthArgs,
  resolveBrowser,
} from "./resolve-browser.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CLOAKBROWSER_BINARY_PATH;
  delete process.env.CLOAKBROWSER_EXECUTABLE_PATH;
  delete process.env.CLOAKBROWSER_CACHE_DIR;
  delete process.env.CLOAKBROWSER_LICENSE_KEY;
  delete process.env.STEEL_DISABLE_CLOAKBROWSER;
  delete process.env.CHROME_EXECUTABLE_PATH;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getCloakStealthArgs", () => {
  it("includes the fingerprint-platform and no-sandbox flags", () => {
    const args = getCloakStealthArgs();
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--fingerprint-platform=windows");
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

  it("falls back to stock Chrome when the override path does not exist", () => {
    process.env.CLOAKBROWSER_BINARY_PATH = "/nonexistent/cloak/chrome";
    const resolved = resolveBrowser();
    // On the CI/dev linux box google-chrome or the patchright fallback applies;
    // either way it must NOT report cloakbrowser.
    expect(resolved.engine).toBe("chrome");
    expect(resolved.executablePath).not.toContain(".cloakbrowser");
  });

  it("auto-detects a cloak cache binary in CLOAKBROWSER_CACHE_DIR", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-cache-"));
    const binaryDir = path.join(dir, "chromium-146.0.7680.177.5");
    fs.mkdirSync(binaryDir);
    const binary = path.join(binaryDir, "chrome");
    fs.writeFileSync(binary, "#!/bin/sh\n");
    fs.chmodSync(binary, 0o755);
    process.env.CLOAKBROWSER_CACHE_DIR = dir;

    const resolved = resolveBrowser();
    expect(resolved.engine).toBe("cloakbrowser");
    expect(resolved.executablePath).toBe(binary);
    expect(resolved.version).toBe("146.0.7680.177.5");
    fs.rmSync(dir, { recursive: true, force: true });
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
    expect(resolved.engine).toBe("cloakbrowser");
    expect(resolved.version).toBe("146.0.7680.177.5");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores the cloak cache when STEEL_DISABLE_CLOAKBROWSER=true", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloak-cache-"));
    const binaryDir = path.join(dir, "chromium-146.0.7680.177.5");
    fs.mkdirSync(binaryDir);
    const binary = path.join(binaryDir, "chrome");
    fs.writeFileSync(binary, "#!/bin/sh\n");
    fs.chmodSync(binary, 0o755);
    process.env.CLOAKBROWSER_CACHE_DIR = dir;
    process.env.STEEL_DISABLE_CLOAKBROWSER = "true";

    const resolved = resolveBrowser();
    expect(resolved.engine).toBe("chrome");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to CHROME_EXECUTABLE_PATH when no cloak binary exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-test-"));
    const binary = path.join(dir, "google-chrome");
    fs.writeFileSync(binary, "#!/bin/sh\n");
    fs.chmodSync(binary, 0o755);
    process.env.CHROME_EXECUTABLE_PATH = binary;

    const resolved = resolveBrowser();
    expect(resolved.engine).toBe("chrome");
    expect(resolved.executablePath).toBe(binary);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
