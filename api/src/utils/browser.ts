import fs from "fs";
import path from "path";
import { env } from "../env.js";

/**
 * Resolve the Chrome binary used for every headful launch.
 * Priority: CHROME_EXECUTABLE_PATH env > platform Chrome locations > patchright's Chromium.
 */
export const getChromeExecutablePath = (): string => {
  if (env.CHROME_EXECUTABLE_PATH) {
    const executablePath = path.normalize(env.CHROME_EXECUTABLE_PATH);
    if (!fs.existsSync(executablePath)) {
      console.warn(`Your custom chrome executable at ${executablePath} does not exist`);
    } else {
      return executablePath;
    }
  }

  if (process.platform === "win32") {
    const programFilesPath = `${process.env["ProgramFiles"]}\\Google\\Chrome\\Application\\chrome.exe`;
    const programFilesX86Path = `C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe`;

    if (fs.existsSync(programFilesPath)) {
      return programFilesPath;
    } else if (fs.existsSync(programFilesX86Path)) {
      return programFilesX86Path;
    }
  }

  if (process.platform === "darwin") {
    const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(macPath)) return macPath;
  }

  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fall back to patchright's own Chromium build.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require("patchright");
    return chromium.executablePath();
  } catch {
    return "/usr/bin/chromium";
  }
};

export function filterHeaders(headers: Record<string, string>) {
  const headersToRemove = [
    "accept-encoding",
    "accept",
    "cache-control",
    "pragma",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "upgrade-insecure-requests",
  ];
  const filteredHeaders = { ...headers };
  headersToRemove.forEach((header) => {
    delete filteredHeaders[header];
  });
  return filteredHeaders;
}
