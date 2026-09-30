import { flushRecording } from "../utils/recording-store.js";
import { FastifyBaseLogger } from "fastify";
import { mkdir, readdir, stat } from "fs/promises";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { env } from "../env.js";
import { CredentialsOptions, SessionDetails } from "../modules/sessions/sessions.schema.js";
import {
  BrowserLauncherOptions,
  OptimizeBandwidthOptions,
} from "../types/index.js";
import { IProxyServer, ProxyServer } from "../utils/proxy.js";
import { getBaseUrl, getUrl } from "../utils/url.js";
import { CDPService } from "./cdp/cdp.service.js";
import { ShutdownReason } from "./cdp/plugins/core/base-plugin.js";
import { CookieData } from "./context/types.js";
import { deepMerge } from "../utils/context.js";

type Session = SessionDetails & {
  completion: Promise<void>;
  complete: (value: void) => void;
  proxyServer: IProxyServer | undefined;
};

const sessionStats = {
  duration: 0,
  eventCount: 0,
  timeout: 0,
  creditsUsed: 0,
  proxyTxBytes: 0,
  proxyRxBytes: 0,
};

const defaultSession = {
  status: "idle" as SessionDetails["status"],
  websocketUrl: getBaseUrl("ws"),
  debugUrl: getUrl("v1/sessions/debug"),
  debuggerUrl: getUrl("v1/devtools/inspector.html"),
  sessionViewerUrl: getBaseUrl(),
  dimensions: { width: 1920, height: 1080 },
  userAgent: "",
  proxy: "",
};

export type ProxyFactory = (
  proxyUrl: string,
  options?: OptimizeBandwidthOptions,
) => Promise<IProxyServer> | IProxyServer;

export class SessionService {
  private logger: FastifyBaseLogger;
  private cdpService: CDPService;
  public proxyFactory: ProxyFactory = (proxyUrl) => new ProxyServer(proxyUrl);

  public pastSessions: Session[] = [];
  public activeSession: Session;

  constructor(config: { cdpService: CDPService; logger: FastifyBaseLogger }) {
    this.cdpService = config.cdpService;
    this.logger = config.logger;
    this.activeSession = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...defaultSession,
      ...sessionStats,
      completion: Promise.resolve(),
      complete: () => {},
      proxyServer: undefined,
    };
  }

  public async startSession(options: {
    sessionId?: string;
    proxyUrl?: string;
    sessionContext?: {
      cookies?: CookieData[];
      localStorage?: Record<string, Record<string, any>>;
    };
    sessionExtensions?: string[];
    logSinkUrl?: string;
    userDataDir?: string;
    /** Uploaded profile id (/v1/profiles) to run this session with. */
    profileId?: string;
    persist?: boolean;
    blockAds?: boolean;
    optimizeBandwidth?: boolean | OptimizeBandwidthOptions;
    timezone?: string;
    dimensions?: { width: number; height: number };
    extra?: Record<string, unknown>;
    credentials?: CredentialsOptions;
    userPreferences?: Record<string, any>;
    deviceConfig?: { device: "desktop" | "mobile" };
    fullscreen?: boolean;
    dangerouslyLogRequestDetails?: boolean;
    captureWorkerNetwork?: boolean;
    caCertificates?: string[];
  }): Promise<SessionDetails> {
    const {
      sessionId,
      proxyUrl,
      sessionContext,
      sessionExtensions,
      logSinkUrl,
      dimensions,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      userPreferences,
      deviceConfig,
      fullscreen,
      dangerouslyLogRequestDetails,
      captureWorkerNetwork,
      caCertificates,
    } = options;

    // Resolve timezone early so the browser launches with the right clock.
    let timezonePromise: Promise<string>;
    if (options.timezone) {
      timezonePromise = Promise.resolve(options.timezone);
    } else {
      const tzFetcher = new (await import("./timezone-fetcher.service.js")).TimezoneFetcher(
        this.logger,
      );
      timezonePromise = tzFetcher.getTimezone(
        proxyUrl,
        env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    }

    const MIN_MOBILE_WIDTH = 508;
    const MIN_MOBILE_HEIGHT = 1074;
    const isMobileDevice = deviceConfig?.device === "mobile";
    const resolvedDimensions = dimensions || this.cdpService.getDimensions();
    const finalDimensions =
      isMobileDevice && resolvedDimensions
        ? {
            width: Math.max(resolvedDimensions.width, MIN_MOBILE_WIDTH),
            height: Math.max(resolvedDimensions.height, MIN_MOBILE_HEIGHT),
          }
        : resolvedDimensions;

    await this.resetSessionInfo({
      id: sessionId || uuidv4(),
      status: "live",
      proxy: proxyUrl,
      dimensions: finalDimensions,
      deviceConfig,
    });

    // Profile selection: an explicit userDataDir wins, then an uploaded
    // profileId (/v1/profiles) materialized into a fresh dir, then the durable
    // default profile (persistent fingerprint) for persist=true, else the
    // tmpdir profile for throwaway sessions.
    let userDataDir: string;
    if (options.userDataDir) {
      userDataDir = options.userDataDir;
    } else if (options.profileId) {
      const { ProfileService } = await import("./profile.service.js");
      const extract = (await import("extract-zip")).default;
      const meta = ProfileService.getInstance().get(options.profileId) as
        | { userDataDir?: string | null }
        | null;
      if (!meta?.userDataDir) {
        throw new Error(`Profile ${options.profileId} not found or has no userDataDir`);
      }
      const { randomUUID } = await import("crypto");
      userDataDir = path.join(os.tmpdir(), `steel-profile-${randomUUID()}`);
      await mkdir(userDataDir, { recursive: true });
      await extract(meta.userDataDir, { dir: userDataDir });
      // Unwrap a single root folder if the archive packed one.
      try {
        const entries = await readdir(userDataDir);
        if (entries.length === 1) {
          const only = path.join(userDataDir, entries[0]);
          if ((await stat(only)).isDirectory()) userDataDir = only;
        }
      } catch {
        // keep the extraction root
      }
    } else if (options.persist === true) {
      userDataDir = env.CHROME_USER_DATA_DIR || path.join(process.cwd(), "user-data-dir");
    } else {
      const { ensureDefaultProfile } = await import("../utils/default-profile.js");
      userDataDir = ensureDefaultProfile();
    }
    await mkdir(userDataDir, { recursive: true });

    const defaultUserPreferences = {
      plugins: {
        always_open_pdf_externally: true,
        plugins_disabled: ["Chrome PDF Viewer"],
      },
    };

    const mergedUserPreferences = userPreferences
      ? deepMerge(defaultUserPreferences, userPreferences)
      : defaultUserPreferences;

    // Normalize optimizeBandwidth: true => enable all flags (except lists)
    const normalizeOptimizeBandwidth = (
      value: boolean | OptimizeBandwidthOptions | undefined,
    ): OptimizeBandwidthOptions | undefined => {
      if (value === true) {
        return { blockImages: true, blockMedia: true, blockStylesheets: true };
      }
      if (value && typeof value === "object") {
        return { ...value };
      }
      return undefined;
    };

    const normalizedOptimize = normalizeOptimizeBandwidth(optimizeBandwidth);

    if (proxyUrl) {
      this.activeSession.proxyServer = await this.proxyFactory(proxyUrl, normalizedOptimize);
      await this.activeSession.proxyServer.listen();
    }

    const browserLauncherOptions: BrowserLauncherOptions = {
      options: {
        proxyUrl: this.activeSession.proxyServer?.url,
      },
      sessionContext,
      blockAds,
      optimizeBandwidth: normalizedOptimize,
      extensions: sessionExtensions,
      timezone: timezonePromise,
      dimensions: finalDimensions,
      userDataDir,
      userPreferences: mergedUserPreferences,
      extra,
      credentials,
      deviceConfig,
      fullscreen,
      dangerouslyLogRequestDetails,
      captureWorkerNetwork,
      caCertificates,
    };

    await this.cdpService.startNewSession(browserLauncherOptions);

    // The browser reports its own real user agent; surface it in session details.
    const userAgent = (await this.cdpService.getLiveUserAgent()) || "";
    // Browser events are tagged with the primary page's CDP target id — the
    // UI's Console/Network tabs query /v1/logs/query?pageId=<this>, so it
    // must be the SAME id the instrumentation stamps (not the session uuid).
    const primaryPage = await this.cdpService
      .getPrimaryPage()
      .catch(() => null);
    const logPageId = primaryPage
      ? await this.cdpService.getTargetId(primaryPage)
      : "";
    Object.assign(this.activeSession, {
      websocketUrl: getBaseUrl("ws"),
      debugUrl: getUrl("v1/sessions/debug"),
      debuggerUrl: getUrl("v1/devtools/inspector.html"),
      sessionViewerUrl: getBaseUrl(),
      userAgent,
      logPageId: logPageId || undefined,
      dimensions: this.cdpService.getDimensions(),
      deviceConfig,
    });

    return this.activeSession;
  }

  public async endSession(options?: { relaunchIdle?: boolean }): Promise<SessionDetails> {
    // Stop the session video recorder if one is still attached. The happy
    // path (scrape/screenshot) stops it explicitly, but a thrown scrape used
    // to leak the ffmpeg x11grab child — it kept encoding an idle screen
    // forever (~35% of a core each on this VM).
    try {
      const leakedRecorder = (this.activeSession as any).__recorder;
      if (leakedRecorder?.stop) {
        (this.activeSession as any).__recorder = null;
        await leakedRecorder.stop();
      }
    } catch {}
    try {
      flushRecording(this.activeSession.id);
    } catch {}
    this.activeSession.complete();
    this.activeSession.status = "released";
    this.activeSession.duration =
      new Date().getTime() - new Date(this.activeSession.createdAt).getTime();

    await this.cdpService.endSession(undefined, { relaunchIdle: options?.relaunchIdle });

    const releasedSession = this.activeSession;
    // resetSessionInfo closes the proxy and clears the field, so hold the
    // reference to read from afterwards.
    const proxyServer = releasedSession.proxyServer;

    await this.resetSessionInfo({
      id: uuidv4(),
      status: "idle",
    });

    // A connection is credited on `connectionClosed`, and long-lived tunnels stay
    // open until the browser goes away, so take the counters once the proxy has
    // closed to get the settled totals.
    if (proxyServer) {
      releasedSession.proxyTxBytes = proxyServer.txBytes;
      releasedSession.proxyRxBytes = proxyServer.rxBytes;
    }

    this.pastSessions.push(releasedSession);

    return releasedSession;
  }

  private async resetSessionInfo(overrides?: Partial<SessionDetails>): Promise<SessionDetails> {
    this.activeSession.complete();

    await this.activeSession.proxyServer?.close(true);
    this.activeSession.proxyServer = undefined;

    const { promise, resolve } = Promise.withResolvers<void>();
    this.activeSession = {
      id: uuidv4(),
      ...defaultSession,
      ...overrides,
      ...sessionStats,
      createdAt: new Date().toISOString(),
      completion: promise,
      complete: resolve,
      proxyServer: undefined,
    };

    return this.activeSession;
  }

  public setProxyFactory(factory: ProxyFactory) {
    this.proxyFactory = factory;
  }
}
