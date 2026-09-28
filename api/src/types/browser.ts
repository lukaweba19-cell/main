import { BrowserEventType } from "./enums.js";
import type { CookieData, IndexedDBDatabase, LocalStorageData, SessionStorageData } from "../services/context/types.js";
import type { CredentialsOptions } from "../modules/sessions/sessions.schema.js";

export interface OptimizeBandwidthOptions {
  blockImages?: boolean;
  blockMedia?: boolean;
  blockStylesheets?: boolean;
  blockHosts?: string[];
  blockUrlPatterns?: string[];
}

export interface BrowserOrgExtensionsExtra {
  paths?: string[];
}

export interface BrowserLaunchExtra {
  orgExtensions?: BrowserOrgExtensionsExtra;
  [key: string]: unknown;
}

/**
 * Options used to launch (or reuse) the shared headful browser.
 *
 * Every launch goes through the same path: patchright Chromium running headful
 * on the Xvfb display, with every extension in the extensions directory loaded
 * automatically. There is no headless mode and no fingerprint spoofing — the
 * browser presents its real configuration.
 */
export interface BrowserLauncherOptions {
  /** Per-context options. `headless` and `userAgent` are intentionally not options. */
  options: BrowserContextOptions;
  sessionContext?: {
    cookies?: CookieData[];
    localStorage?: Record<string, LocalStorageData>;
    sessionStorage?: Record<string, SessionStorageData>;
    indexedDB?: Record<string, IndexedDBDatabase[]>;
  };
  /** Named extensions from the extensions directory. All directory extensions are loaded anyway; extra names must also exist there. */
  extensions?: string[];
  blockAds?: boolean;
  optimizeBandwidth?: boolean | OptimizeBandwidthOptions;
  customHeaders?: Record<string, string>;
  timezone?: Promise<string>;
  dimensions?: {
    width: number;
    height: number;
  } | null;
  userDataDir?: string;
  userPreferences?: Record<string, any>;
  extra?: BrowserLaunchExtra;
  credentials?: CredentialsOptions;
  deviceConfig?: { device: "desktop" | "mobile" };
  fullscreen?: boolean;
  dangerouslyLogRequestDetails?: boolean;
  captureWorkerNetwork?: boolean;
  caCertificates?: string[];
}

export interface BrowserContextOptions {
  /** Local proxy server URL (never a hard-coded upstream — users pass their own proxy). */
  proxyUrl?: string;
  args?: string[];
}

export type BrowserEvent = {
  type: BrowserEventType;
  text: string;
  timestamp: Date;
};
