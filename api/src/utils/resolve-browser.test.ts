import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BrowserNotFoundError,
  resolveBrowser,
} from "./resolve-browser.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CHROME_EXECUTABLE_PATH;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeFakeChrome(dir: string, name = "google-chrome"): string {
  fs.mkdirSync(dir, { recursive: true });
  const binary = path.join(dir, name);
  fs.writeFileSync(binary, "#!/bin/sh\necho 'Chromium 146.0.0.0'\n");
  fs.chmodSync(binary, 0o755);
  return binary;
}

describe("resolveBrowser (nodriver stack)", () => {
  it("honors CHROME_EXECUTABLE_PATH override", () => {
    const binary = makeFakeChrome(fs.mkdtempSync(path.join(os.tmpdir(), "chrome-override-")));
    process.env.CHROME_EXECUTABLE_PATH = binary;
    const resolved = resolveBrowser();
    expect(resolved.executablePath).toBe(path.normalize(binary));
    expect(resolved.engine).toBe("chrome");
  });

  it("throws BrowserNotFoundError for a nonexistent override", () => {
    process.env.CHROME_EXECUTABLE_PATH = "/definitely/not/here/chrome";
    expect(() => resolveBrowser()).toThrow(BrowserNotFoundError);
  });

  it("finds chrome on the PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-path-"));
    const binary = makeFakeChrome(dir);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    const resolved = resolveBrowser();
    expect(resolved.executablePath).toBe(binary);
    expect(resolved.engine).toBe("chrome");
  });

  it("prefers the explicit override over PATH entries", () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-b-"));
    const pathBinary = makeFakeChrome(dirA);
    const overrideBinary = makeFakeChrome(dirB);
    process.env.PATH = `${dirA}:${process.env.PATH}`;
    process.env.CHROME_EXECUTABLE_PATH = overrideBinary;
    const resolved = resolveBrowser();
    expect(resolved.executablePath).toBe(path.normalize(overrideBinary));
    expect(pathBinary).toBeTruthy(); // silence unused-var lint
  });

  it("does not export any fingerprint-seed helper (no per-launch seeds)", async () => {
    // The CloakBrowser-era per-launch --fingerprint=<seed> argument is gone;
    // fingerprint persistence now lives entirely in the durable profile dir.
    const mod = await import("./resolve-browser.js");
    expect((mod as Record<string, unknown>).getCloakStealthArgs).toBeUndefined();
  });
});
