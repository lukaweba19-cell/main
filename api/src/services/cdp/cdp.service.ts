import { execSync } from "node:child_process";
import { EventEmitter } from "events";
import { FastifyBaseLogger } from "fastify";
import fs from "fs";
import { IncomingMessage } from "http";
import httpProxy from "http-proxy";
import os from "os";
import path from "path";
import {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightContext,
  Cookie as PlaywrightCookie,
  Page as PlaywrightPage,
  chromium,
} from "patchright";
import { TargetType } from "./instrumentation/pw-types.js";
import { Duplex } from "stream";
import { env } from "../../env.js";
import { traceable, tracer } from "../../telemetry/tracer.js";
import { BrowserEventType, BrowserLauncherOptions, EmitEvent } from "../../types/index.js";
import {
  tryParseUrl,
  isAdRequest,
  isHeavyMediaRequest,
  isHostBlocked,
  isUrlMatchingPatterns,
  compileUrlPatterns,
  isImageRequest,
} from "../../utils/requests.js";
import {
  BrowserNotFoundError,
  getCloakStealthArgs,
  resolveBrowser,
} from "../../utils/resolve-browser.js";
import {
  deepMerge,
  extractStorageForPageWithTimeout,
  getProfilePath,
  groupSessionStorageByOrigin,
  handleFrameNavigated,
  safePageUrl,
} from "../../utils/context.js";
import { getExtensionPaths } from "../../utils/extensions.js";
import { RetryManager, RetryOptions } from "../../utils/retry.js";
import { isTargetClosedError } from "../../utils/target-closed.js";
import { ChromeContextService } from "../context/chrome-context.service.js";
import { SessionData } from "../context/types.js";
import { FileService } from "../file.service.js";
import {
  BaseLaunchError,
  BrowserProcessError,
  BrowserProcessState,
  CleanupError,
  CleanupType,
  LaunchTimeoutError,
  NetworkError,
  NetworkOperation,
  PluginError,
  PluginName,
  PluginOperation,
  ResourceError,
  ResourceType,
  SessionContextError,
  SessionContextType,
  categorizeError,
} from "./errors/launch-errors.js";
import { BasePlugin, ShutdownReason } from "./plugins/core/base-plugin.js";
import { PluginManager } from "./plugins/core/plugin-manager.js";
import { isSimilarConfig, validateLaunchConfig, validateTimezone } from "./utils/validation.js";
import { TargetInstrumentationManager } from "./instrumentation/target-manager.js";
import {
  createBrowserLogger as createInstrumentationLogger,
  BrowserLogger,
} from "./instrumentation/browser-logger.js";
import { executeBestEffort, executeCritical, executeOptional } from "./utils/error-handlers.js";
import { TimezoneFetcher } from "../timezone-fetcher.service.js";

/**
 * Single headful Chromium (patchright) behind the whole API.
 *
 * Invariants:
 * - Headful always. Chrome runs against the Xvfb display; there is no headless mode.
 * - Every extension in the extensions directory is loaded on every launch, by default.
 * - No fingerprint spoofing and no user-agent overrides: the browser presents itself.
 * - One launch path for sessions and scrapes; the browser is shut down when idle.
 */
export class CDPService extends EventEmitter {
  private logger: FastifyBaseLogger;
  private browserInstance: PlaywrightBrowser | null;
  private wsEndpoint: string | null;
  private sessionContext: SessionData | null;
  private chromeExecPath: string;
  private browserEngine: "cloakbrowser" | "chrome";
  private wsProxyServer: httpProxy;
  private primaryPage: PlaywrightPage | null;
  private launchConfig?: BrowserLauncherOptions;
  private defaultLaunchConfig: BrowserLauncherOptions;
  private currentSessionConfig: BrowserLauncherOptions | null;
  private shuttingDown: boolean;
  private defaultTimezone: string;
  private pluginManager: PluginManager;
  private trackedOrigins: Set<string> = new Set<string>();
  private crashedPages: WeakSet<PlaywrightPage> = new WeakSet<PlaywrightPage>();
  private chromeSessionService: ChromeContextService;
  private retryManager: RetryManager;
  private targetInstrumentationManager: TargetInstrumentationManager;
  private instrumentationLogger: BrowserLogger;

  private compiledUrlPatterns: RegExp[] = [];
  private launchMutators: ((config: BrowserLauncherOptions) => Promise<void> | void)[] = [];
  private shutdownMutators: ((config: BrowserLauncherOptions | null) => Promise<void> | void)[] =
    [];
  private proxyWebSocketHandler:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>)
    | null = null;
  private disconnectHandler: () => Promise<void> = async () => {};

  constructor(
    config: { keepAlive?: boolean },
    logger: FastifyBaseLogger,
    storage?: any,
    enableConsoleLogging?: boolean,
  ) {
    super();
    this.logger = logger.child({ component: "CDPService" });
    this.browserInstance = null;
    this.wsEndpoint = null;
    this.sessionContext = null;
    // CloakBrowser-only: resolve the stealth binary up front. A missing
    // binary is a configuration error, not a fallback situation.
    try {
      const resolved = resolveBrowser();
      this.chromeExecPath = resolved.executablePath;
      this.browserEngine = "cloakbrowser";
      this.logger.info(
        `[CDPService] CloakBrowser stealth Chromium: ${resolved.executablePath}` +
          (resolved.version ? ` (v${resolved.version})` : ""),
      );
    } catch (err) {
      if (err instanceof BrowserNotFoundError) {
        this.logger.error(`[CDPService] ${err.message}`);
      }
      // Defer the throw to launch time so the service still boots and can
      // serve /health; every launch attempt will surface the same error.
      this.chromeExecPath = "";
      this.browserEngine = "cloakbrowser";
    }
    this.defaultTimezone = env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.trackedOrigins = new Set<string>();
    this.chromeSessionService = new ChromeContextService(logger);
    this.retryManager = new RetryManager(logger);

    this.wsProxyServer = httpProxy.createProxyServer();
    this.wsProxyServer.on("error", (err) => {
      this.logger.error(`Proxy server error: ${err}`);
    });

    this.primaryPage = null;
    this.currentSessionConfig = null;
    this.shuttingDown = false;

    const timezoneFetcher = new TimezoneFetcher(logger);
    const coldStartTimezone = timezoneFetcher.getTimezone(undefined, this.defaultTimezone);

    this.defaultLaunchConfig = {
      options: {},
      blockAds: true,
      extensions: [],
      userDataDir: env.CHROME_USER_DATA_DIR || path.join(os.tmpdir(), "steel-chrome"),
      timezone: coldStartTimezone,
      userPreferences: {
        plugins: {
          always_open_pdf_externally: true,
          plugins_disabled: ["Chrome PDF Viewer"],
        },
      },
      deviceConfig: { device: "desktop" },
    };

    this.pluginManager = new PluginManager(this, logger);

    this.instrumentationLogger = createInstrumentationLogger({
      baseLogger: this.logger,
      initialContext: {},
      storage: storage || null,
      enableConsoleLogging: enableConsoleLogging ?? true,
    });
    this.targetInstrumentationManager = new TargetInstrumentationManager(
      this.instrumentationLogger,
      this.logger,
    );
    this.instrumentationLogger?.on?.(EmitEvent.Log, (event, context) => {
      this.emit(EmitEvent.Log, event);
    });
    this.logger.info("[CDPService] Target instrumentation enabled (patchright, headful)");
  }

  public getInstrumentationLogger(): BrowserLogger {
    return this.instrumentationLogger;
  }

  public getLogger(name: string) {
    return this.logger.child({ component: name });
  }

  public setChromeExecPath(execPath: string): void {
    this.chromeExecPath = execPath;
  }

  /** Which engine the launcher is configured to use. Always cloakbrowser. */
  public getBrowserEngine(): "cloakbrowser" | "chrome" {
    return this.browserEngine;
  }

  public setProxyWebSocketHandler(
    handler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>) | null,
  ): void {
    this.proxyWebSocketHandler = handler;
  }

  public setDisconnectHandler(handler: () => Promise<void>): void {
    this.disconnectHandler = handler;
  }

  public getBrowserInstance(): PlaywrightBrowser | null {
    return this.browserInstance;
  }

  public getLaunchConfig(): BrowserLauncherOptions | undefined {
    return this.launchConfig;
  }

  public getSessionContext(): SessionData | null {
    return this.sessionContext;
  }

  public registerLaunchHook(fn: (config: BrowserLauncherOptions) => Promise<void> | void) {
    this.launchMutators.push(fn);
  }

  public registerShutdownHook(fn: (config: BrowserLauncherOptions | null) => Promise<void> | void) {
    this.shutdownMutators.push(fn);
  }

  private removeAllHandlers() {
    this.browserInstance?.removeAllListeners();
    this.removeAllListeners();
  }

  public isRunning(): boolean {
    return !!this.browserInstance && this.browserInstance.isConnected();
  }

  /** CDP target id of a page, fetched via CDP and cached on the page object. */
  public async getTargetId(page: PlaywrightPage): Promise<string> {
    const cached = (page as any).__steelTargetId;
    if (cached) return cached;
    try {
      const client = await (page.context() as any).newCDPSession(page);
      const { targetInfo } = await client.send("Target.getTargetInfo");
      await client.detach().catch(() => {});
      (page as any).__steelTargetId = targetInfo.targetId;
      return targetInfo.targetId;
    } catch {
      return "";
    }
  }

  public async getPrimaryPage(): Promise<PlaywrightPage> {
    if (!this.primaryPage || !this.browserInstance) {
      throw new Error("CDPService has not been launched yet!");
    }
    if (this.primaryPage.isClosed()) {
      this.primaryPage = await this.browserInstance.newPage();
    }
    return this.primaryPage;
  }

  private getDebuggerBase(): { baseUrl: string; protocol: string; wsProtocol: string } {
    const baseUrl = env.CDP_DOMAIN ?? env.DOMAIN ?? `${env.HOST}:${env.CDP_REDIRECT_PORT}`;
    const protocol = env.USE_SSL ? "https" : "http";
    const wsProtocol = env.USE_SSL ? "wss" : "ws";
    return { baseUrl, protocol, wsProtocol };
  }

  public getDebuggerUrl() {
    const { baseUrl, protocol } = this.getDebuggerBase();
    return `${protocol}://${baseUrl}/devtools/devtools_app.html`;
  }

  public getDebuggerWsUrl(pageId?: string) {
    const { baseUrl, wsProtocol } = this.getDebuggerBase();
    if (!pageId) {
      if (!this.primaryPage) {
        throw new Error("Browser or primary page not initialized");
      }
      // Prefer the cached id; getTargetId is async and fetches over CDP.
      pageId =
        (this.primaryPage as any).__steelTargetId ??
        (this.primaryPage as any)._delegate?._targetId ??
        "";
      if (!pageId) {
        throw new Error("Primary page target id not yet resolved");
      }
    }
    return `${wsProtocol}://${baseUrl}/devtools/page/${pageId}`;
  }

  public async refreshPrimaryPage() {
    const newPage = await this.createPage();
    if (this.primaryPage && !this.primaryPage.isClosed()) {
      await this.pluginManager.onBeforePageClose(this.primaryPage);
      await this.primaryPage.close().catch(() => {});
    }
    this.primaryPage = newPage;
  }

  public registerPlugin(plugin: BasePlugin) {
    return this.pluginManager.register(plugin);
  }

  public unregisterPlugin(pluginName: string) {
    return this.pluginManager.unregister(pluginName);
  }

  private async handleTargetChange(target: any) {
    if (target.type() !== "page") return;

    const page = await target.page().catch((e) => {
      this.logger.error(`Error handling target change in CDPService: ${e}`);
      return null;
    });

    if (page) {
      this.pluginManager.onPageNavigate(page);

      const pageId = await this.getTargetId(page);

      try {
        const url = page.url();
        if (url && url.startsWith("http")) {
          const origin = new URL(url).origin;
          this.trackedOrigins.add(origin);
          this.logger.debug(`[CDPService] Tracking new origin: ${origin}`);
        }
      } catch (err) {
        this.logger.error(`[CDPService] Error tracking origin: ${err}`);
      }

      this.emit(EmitEvent.PageId, { pageId });
    }
  }

  private async launchInternal(config?: BrowserLauncherOptions): Promise<PlaywrightBrowser> {
    try {
      const launchTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new LaunchTimeoutError(60000)), 60000);
      });

      const launchProcess = (async () => {
        const shouldReuseInstance =
          this.browserInstance &&
          !this.shuttingDown &&
          (await isSimilarConfig(this.launchConfig, config || this.defaultLaunchConfig));

        if (shouldReuseInstance) {
          this.logger.info(
            "[CDPService] Reusing existing headful browser instance with matching configuration.",
          );
          this.launchConfig = config || this.defaultLaunchConfig;

          const reuseOptimize = this.launchConfig.optimizeBandwidth;
          const reusePatterns =
            typeof reuseOptimize === "object" ? reuseOptimize.blockUrlPatterns : undefined;
          this.compiledUrlPatterns = reusePatterns?.length ? compileUrlPatterns(reusePatterns) : [];

          await executeCritical(
            async () => this.refreshPrimaryPage(),
            (error) =>
              new BrowserProcessError(
                "Failed to refresh primary page when reusing browser instance",
                BrowserProcessState.PAGE_REFRESH,
                error,
              ),
          );

          if (this.launchConfig?.sessionContext) {
            this.logger.debug(
              `[CDPService] Session created with session context, injecting session context`,
            );
            await executeCritical(
              async () =>
                this.injectSessionContext(this.primaryPage!, this.launchConfig!.sessionContext!),
              (error) => {
                const contextError = new SessionContextError(
                  error instanceof Error ? error.message : String(error),
                  SessionContextType.CONTEXT_INJECTION,
                  error,
                );
                this.logger.warn(`[CDPService] ${contextError.message} - throwing error`);
                return contextError;
              },
            );
          }
          if (!this.shuttingDown && this.browserInstance) {
            await this.pluginManager.onBrowserReady(this.launchConfig);
          } else {
            this.logger.warn(
              `[CDPService] Skipping onBrowserReady: shuttingDown=${
                this.shuttingDown
              }, browserInstance=${!!this.browserInstance}`,
            );
          }

          return this.browserInstance!;
        } else if (this.browserInstance) {
          this.logger.info(
            "[CDPService] Existing browser instance detected. Closing it before launching a new one.",
          );
          await executeBestEffort(
            this.logger,
            async () => this.shutdown(ShutdownReason.RELAUNCH),
            "Error during shutdown before launch",
          );
        }

        this.launchConfig = config || this.defaultLaunchConfig;

        const optimize = this.launchConfig.optimizeBandwidth;
        const rawPatterns = typeof optimize === "object" ? optimize.blockUrlPatterns : undefined;
        this.compiledUrlPatterns = rawPatterns?.length ? compileUrlPatterns(rawPatterns) : [];

        this.logger.info("[CDPService] Launching new headful browser instance.");

        await executeCritical(
          async () => validateLaunchConfig(this.launchConfig!),
          (error) => categorizeError(error, "configuration validation"),
        );

        this.logger.info("[CDPService] Cleaning up files before browser launch");
        await executeOptional(
          this.logger,
          async () => {
            await FileService.getInstance().cleanupFiles();
            this.logger.info("[CDPService] Files cleaned successfully before launch");
          },
          (error) =>
            new CleanupError(
              error instanceof Error ? error.message : String(error),
              CleanupType.PRE_LAUNCH_FILE_CLEANUP,
              error,
            ),
        );

        const { options, userDataDir } = this.launchConfig;

        await executeCritical(
          async () => {
            for (const mutator of this.launchMutators) {
              await mutator(this.launchConfig!);
            }
          },
          (error) =>
            new PluginError(
              error instanceof Error ? error.message : String(error),
              PluginName.LAUNCH_MUTATOR,
              PluginOperation.PRE_LAUNCH_HOOK,
              true,
              error,
            ),
        );

        let timezone = this.defaultTimezone;
        if (config?.timezone) {
          const validatedTimezone = await executeOptional(
            this.logger,
            async () => {
              const tz = await validateTimezone(this.logger, config.timezone!);
              this.logger.info(`Resolved and validated timezone: ${tz}`);
              return tz;
            },
            (error) => {
              this.logger.warn(`Timezone validation failed, using fallback`);
              return categorizeError(error, "timezone validation");
            },
            this.defaultTimezone,
          );
          timezone = validatedTimezone ?? this.defaultTimezone;
        }

        // Every extension in the extensions directory loads by default; any
        // extra named extensions requested by the caller must exist there too.
        const extensionPaths = await executeCritical(
          async () => getExtensionPaths(this.launchConfig!.extensions ?? []),
          (error) =>
            new ResourceError(
              `Failed to resolve extension paths: ${error}`,
              ResourceType.EXTENSIONS,
              false,
              error,
            ),
        );

        const shouldDisableSandbox =
          env.DISABLE_CHROME_SANDBOX ||
          (typeof process.getuid === "function" && process.getuid() === 0);

        const staticDefaultArgs = [
          "--remote-allow-origins=*",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=TranslateUI,PrivacySandboxSettings4,InterestFeedContentSuggestions,MediaRouter,DialMediaRouteProvider,OptimizationHints",
          "--enable-features=Clipboard",
          "--no-default-browser-check",
          "--disable-sync",
          "--disable-translate",
          "--no-first-run",
          "--disable-search-engine-choice-screen",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--force-webrtc-ip-handling-policy",
          "--disable-touch-editing",
          "--disable-touch-drag-drop",
          "--disable-client-side-phishing-detection",
          "--disable-default-apps",
          "--disable-component-update",
          "--disable-infobars",
          "--disable-breakpad",
          "--disable-background-networking",
          "--disable-session-crashed-bubble",
          "--disable-ipc-flooding-protection",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--disable-domain-reliability",
          "--metrics-recording-only",
          "--no-pings",
          "--disable-backing-store-limit",
          "--password-store=basic",
          ...(shouldDisableSandbox
            ? ["--no-sandbox", "--disable-setuid-sandbox", "--no-zygote"]
            : []),
        ];

        const headfulArgs = [
          "--ozone-platform=x11",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
          "--in-process-gpu",
          "--enable-crashpad",
          "--crash-dumps-dir=/tmp/chrome-dumps",
          "--noerrdialogs",
          "--force-device-scale-factor=1",
          "--disable-hang-monitor",
        ];

        const dynamicArgs = [
          this.launchConfig.dimensions ? "" : "--start-maximized",
          `--remote-debugging-address=127.0.0.1`,
          `--remote-debugging-port=${env.CDP_REDIRECT_PORT}`,
          `--window-size=${this.launchConfig.dimensions?.width ?? 1920},${
            this.launchConfig.dimensions?.height ?? 1080
          }`,
          this.launchConfig.fullscreen === true ? "--kiosk" : "",
        ];

        if (!this.chromeExecPath) {
          throw new BrowserNotFoundError(
            "CloakBrowser binary not found. Install it with: npx cloakbrowser install",
          );
        }

        const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

        // CloakBrowser's C++ patches are driven by its own flags. When the
        // stealth binary is in use, pass the same args the official wrapper
        // would (--fingerprint=<seed>, --fingerprint-platform=windows) so the
        // patched code paths activate. Its binary tolerates our full arg set.
        const engineArgs =
          this.browserEngine === "cloakbrowser" ? getCloakStealthArgs() : [];

        const launchArgs = uniq([
          ...staticDefaultArgs,
          ...headfulArgs,
          ...dynamicArgs,
          ...engineArgs,
          // Every extension resolved from the extensions directory loads by
          // default. (Regression: the Patchright migration dropped these args,
          // so uploaded extensions silently stopped loading.)
          ...(extensionPaths.length
            ? [
                `--load-extension=${extensionPaths.join(",")}`,
                `--disable-extensions-except=${extensionPaths.join(",")}`,
              ]
            : []),
          ...(options.args || []),
          ...(env.CHROME_ARGS || []),
        ]).filter((arg) => !env.FILTER_CHROME_ARGS.includes(arg));

        const userDataDirToUse =
          userDataDir || env.CHROME_USER_DATA_DIR || path.join(os.tmpdir(), "steel-chrome");
        await fs.promises.mkdir(userDataDirToUse, { recursive: true });

        if (this.launchConfig.userPreferences) {
          this.logger.info(`[CDPService] Setting up user preferences in ${userDataDirToUse}`);
          await executeBestEffort(
            this.logger,
            async () =>
              this.setupUserPreferences(userDataDirToUse, this.launchConfig!.userPreferences!),
            "Failed to set up user preferences",
          );
        }

        // Persistent context = real Chrome profile directory. This is what makes
        // --load-extension work and behaves exactly like a user-launched browser.
        const launchOptions: Record<string, unknown> = {
          headless: false as const,
          executablePath: this.chromeExecPath || undefined,
          viewport: this.launchConfig.dimensions
            ? {
                width: this.launchConfig.dimensions.width,
                height: this.launchConfig.dimensions.height,
              }
            : null,
          args: launchArgs,
          ignoreDefaultArgs: ["--enable-automation"],
          timeout: 0,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          env: {
            ...process.env,
            HOME: os.userInfo().homedir,
            TZ: timezone,
            DISPLAY: env.DISPLAY,
          },
          proxy: options.proxyUrl ? { server: options.proxyUrl } : undefined,
          dumpio: env.DEBUG_CHROME_PROCESS,
        };

        this.logger.info(`[CDPService] Launch Options:`);
        this.logger.info(JSON.stringify({ ...launchOptions, env: undefined }, null, 2));

        this.browserInstance = await executeCritical(
          async () =>
            (await tracer.startActiveSpan("CDPService.launchBrowser", async () => {
              return await chromium.launchPersistentContext(userDataDirToUse, launchOptions as any);
            })) as unknown as PlaywrightBrowser,
          (error) =>
            new BrowserProcessError(
              error instanceof Error ? error.message : String(error),
              BrowserProcessState.LAUNCH_FAILED,
              error,
            ),
        );

        // Persistent contexts expose their browser handle for target-level events.
        const contextAny = this.browserInstance as unknown as any;
        const browserHandle: PlaywrightBrowser =
          contextAny.browser?.() ?? (this.browserInstance as unknown as PlaywrightBrowser);

        await executeOptional(
          this.logger,
          async () => this.pluginManager.onBrowserLaunch(browserHandle as any),
          (error) =>
            new PluginError(
              error instanceof Error ? error.message : String(error),
              PluginName.PLUGIN_MANAGER,
              PluginOperation.BROWSER_LAUNCH_NOTIFICATION,
              true,
              error,
            ),
        );

        (browserHandle as any).on?.("disconnected", this.onDisconnect.bind(this));

        const pages = await executeCritical(
          async () => (await (this.browserInstance as any).pages()) as PlaywrightPage[],
          (error) =>
            new BrowserProcessError(
              "Failed to get pages from browser instance",
              BrowserProcessState.PAGE_ACCESS,
              error,
            ),
        );
        this.primaryPage = pages[0] ?? (await this.createPage());

        if (this.launchConfig?.sessionContext) {
          this.logger.debug(
            `[CDPService] Session created with session context, injecting session context`,
          );
          await executeCritical(
            async () =>
              this.injectSessionContext(this.primaryPage!, this.launchConfig!.sessionContext!),
            (error) => {
              const contextError = new SessionContextError(
                error instanceof Error ? error.message : String(error),
                SessionContextType.CONTEXT_INJECTION,
                error,
              );
              this.logger.warn(`[CDPService] ${contextError.message} - throwing error`);
              return contextError;
            },
          );
        }

        // Configure browser download behavior
        await executeBestEffort(
          this.logger,
          async () => {
            const downloadPath = FileService.getInstance().getBaseFilesPath();
            const cdpSession = await (this.primaryPage!.context() as any).newCDPSession(
              this.primaryPage!,
            );
            await cdpSession.send("Browser.setDownloadBehavior", {
              behavior: "allow",
              downloadPath: downloadPath,
              eventsEnabled: true,
            });
            await cdpSession.detach();
            this.logger.debug(
              `[CDPService] Download behavior configured with path: ${downloadPath}`,
            );
          },
          "Failed to configure download behavior",
        );

        // Final setup steps: instrument every current and future target.
        await executeOptional(
          this.logger,
          async () => {
            for (const page of await (this.browserInstance as any).pages()) {
              await this.attachPageInstrumentation(page);
            }
          },
          (error) =>
            new BrowserProcessError(
              error instanceof Error ? error.message : String(error),
              BrowserProcessState.TARGET_SETUP,
              error,
            ),
        );

        (this.browserInstance as any).on("page", (page: PlaywrightPage) => {
          void this.attachPageInstrumentation(page).catch((error) => {
            if (isTargetClosedError(error)) {
              this.logger.debug(
                { err: error },
                "[CDPService] Page closed while attaching instrumentation",
              );
              return;
            }
            this.logger.error({ err: error }, "[CDPService] Unhandled error in page setup");
          });
        });

        if (!this.shuttingDown && this.browserInstance) {
          await this.pluginManager.onBrowserReady(this.launchConfig);
        } else {
          this.logger.warn(
            `[CDPService] Skipping onBrowserReady: shuttingDown=${
              this.shuttingDown
            }, browserInstance=${!!this.browserInstance}`,
          );
        }

        return browserHandle;
      })();

      return (await Promise.race([launchProcess, launchTimeout])) as PlaywrightBrowser;
    } catch (error: unknown) {
      const categorizedError =
        error instanceof BaseLaunchError ? error : categorizeError(error, "browser launch");

      this.logger.error(
        {
          error: {
            errorType: categorizedError.type,
            isRetryable: categorizedError.isRetryable,
            context: categorizedError.context,
          },
        },
        `[CDPService] LAUNCH ERROR (${categorizedError.type}): ${categorizedError.message}`,
      );

      throw categorizedError;
    }
  }

  /** Wire request rules, tracking and plugins onto a page; safe to call twice. */
  private async attachPageInstrumentation(page: PlaywrightPage): Promise<void> {
    const pageId = await this.getTargetId(page);
    (page as any).__steelPageId = pageId;

    try {
      await this.targetInstrumentationManager.attach(
        {
          url: () => page.url(),
          type: () => "page",
          page: async () => page,
          createCDPSession: async () =>
            (page.context() as any).newCDPSession(page),
          asPage: async () => page,
        } as any,
        TargetType.PAGE,
      );
    } catch (error) {
      if (!isTargetClosedError(error)) {
        this.logger.error({ err: error }, `[CDPService] Error attaching target instrumentation`);
      }
    }

    if (page.isClosed()) return;

    page.on("crash", () => {
      this.crashedPages.add(page);
      this.logger.error({ url: safePageUrl(page) }, "[CDPService] Page renderer crashed");
    });

    try {
      if (this.launchConfig?.customHeaders) {
        await page
          .setExtraHTTPHeaders({ ...env.DEFAULT_HEADERS, ...this.launchConfig.customHeaders })
          .catch(() => {});
      } else if (env.DEFAULT_HEADERS) {
        await page.setExtraHTTPHeaders(env.DEFAULT_HEADERS).catch(() => {});
      }

      // Request interception breaks Cloudflare Turnstile / Service Workers
      // (blob: importScripts NetworkError). Only enable when we actually need
      // to block resources (ads / bandwidth optimization / URL patterns).
      const needsInterception =
        !!this.launchConfig?.blockAds ||
        !!this.launchConfig?.optimizeBandwidth ||
        (this.compiledUrlPatterns?.length ?? 0) > 0;

      if (needsInterception) {
        await page.route("**/*", (route) => {
          this.handlePageRequest(route, page).catch(() => {});
        });
      }

      page.on("response", (response) => {
        if (response.url().startsWith("file://")) {
          this.logger.error(`[CDPService] Blocked response from file protocol: ${response.url()}`);
          page.close().catch(() => {});
          this.endSession(ShutdownReason.SECURITY_VIOLATION);
        }
      });

      await this.pluginManager.onPageCreated(page);

      this.emit(EmitEvent.PageId, { pageId });
    } catch (error) {
      if (isTargetClosedError(error) || page.isClosed()) {
        this.logger.debug(
          { err: error },
          "[CDPService] Page closed while configuring instrumentation",
        );
        return;
      }
      this.logger.error({ err: error }, "[CDPService] Error configuring new page");
    }
  }

  private async handlePageRequest(route: any, page: PlaywrightPage) {
    const url = route.request().url();
    const parsed = tryParseUrl(url);

    const optimize = this.launchConfig?.optimizeBandwidth;
    const isOptimizeObject = typeof optimize === "object";
    const blockedHosts = isOptimizeObject ? optimize.blockHosts : undefined;

    if (parsed && this.launchConfig?.blockAds && isAdRequest(parsed)) {
      this.logger.info(`[CDPService] Blocked request to ad related resource: ${url}`);
      await route.abort().catch(() => {});
      return;
    }

    if (
      (parsed && isHostBlocked(parsed, blockedHosts)) ||
      isUrlMatchingPatterns(url, this.compiledUrlPatterns)
    ) {
      this.logger.info(`[CDPService] Blocked request to blocked host or pattern: ${url}`);
      await route.abort().catch(() => {});
      return;
    }

    const blockImages = isOptimizeObject ? !!optimize.blockImages : false;
    const blockMedia = isOptimizeObject ? !!optimize.blockMedia : false;
    const blockStylesheets = isOptimizeObject ? !!optimize.blockStylesheets : false;

    if (parsed && (blockImages || blockMedia || blockStylesheets)) {
      const resourceType = route.request().resourceType();
      if (
        (blockImages && (resourceType === "image" || isImageRequest(parsed))) ||
        (blockMedia && (resourceType === "media" || isHeavyMediaRequest(parsed))) ||
        (blockStylesheets && resourceType === "stylesheet")
      ) {
        this.logger.info(
          `[CDPService] Blocked ${resourceType} resource due to optimizeBandwidth (${url})`,
        );
        await route.abort().catch(() => {});
        return;
      }
    }

    if (url.startsWith("file://")) {
      this.logger.error(`[CDPService] Blocked request to file protocol: ${url}`);
      page.close().catch(() => {});
      this.endSession(ShutdownReason.SECURITY_VIOLATION);
    } else {
      await route.continue().catch(() => {});
    }
  }

  public async createPage(): Promise<PlaywrightPage> {
    if (!this.browserInstance) {
      throw new Error("Browser instance not initialized");
    }
    return this.browserInstance.newPage();
  }

  private async shutdownHook() {
    for (const mutator of this.shutdownMutators) {
      await mutator(this.currentSessionConfig);
    }
  }

  @traceable
  public async shutdown(reason: ShutdownReason): Promise<void> {
    this.shuttingDown = true;
    this.logger.info(`[CDPService] Shutting down and cleaning up resources (reason: ${reason})`);
    this.chromeSessionService.invalidate();

    try {
      if (this.browserInstance) {
        await this.pluginManager.onBrowserClose(this.browserInstance as any);
      }

      await this.pluginManager.onShutdown(reason);

      this.removeAllHandlers();
      // Bound the close call: on a crashed/already-dead browser the CDP
      // transport may never answer, and an unbounded close would wedge
      // every future job waiting on this service.
      await Promise.race([
        this.browserInstance?.close().catch(() => {}) ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
      await this.shutdownHook();

      this.logger.info("[CDPService] Cleaning up files during shutdown");
      try {
        await FileService.getInstance().cleanupFiles();
        this.logger.info("[CDPService] Files cleaned successfully");
      } catch (error) {
        this.logger.error(`[CDPService] Error cleaning files during shutdown: ${error}`);
      }

      this.currentSessionConfig = null;
      this.browserInstance = null;
      this.primaryPage = null as any;
      this.wsEndpoint = null;
      this.emit("close");
      this.shuttingDown = false;
    } catch (error) {
      this.logger.error(`[CDPService] Error during shutdown: ${error}`);
      await this.browserInstance?.close().catch(() => {});
      await this.shutdownHook();

      try {
        await FileService.getInstance().cleanupFiles();
      } catch (cleanupError) {
        this.logger.error(
          `[CDPService] Error cleaning files during error recovery: ${cleanupError}`,
        );
      }

      this.browserInstance = null;
      this.primaryPage = null as any;
      this.shuttingDown = false;
    }
  }

  /** Serialize launches so concurrent scrapes do not race launch/shutdown. */
  private launchChain: Promise<void> = Promise.resolve();

  /**
   * Ensure the shared headful browser is up. All work (sessions, scrapes, casts)
   * funnels through here; extensions load automatically on every launch.
   */
  public async ensureBrowser(config?: BrowserLauncherOptions): Promise<void> {
    const merged: BrowserLauncherOptions = {
      ...(config || {}),
      options: { ...((config && config.options) || {}) },
    };
    const run = async () => {
      // Wait out any in-flight shutdown so we never launch into (or reuse)
      // a browser that is being torn down.
      for (let i = 0; i < 100 && this.shuttingDown; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.isRunning() && this.browserInstance) return;
      await this.launch(merged);
      if (!this.browserInstance || !this.browserInstance.isConnected()) {
        throw new Error("Browser instance not initialized after launch");
      }
    };
    this.launchChain = this.launchChain.then(run, run);
    await this.launchChain;
  }

  public async createBrowserContext(proxyUrl?: string | null): Promise<PlaywrightContext> {
    await this.ensureBrowser();
    if (!this.browserInstance) {
      throw new Error("Browser instance not initialized");
    }
    if (proxyUrl) {
      return this.browserInstance.newContext({ proxy: { server: proxyUrl } });
    }
    return this.browserInstance.newContext();
  }

  @traceable
  public async launch(
    config?: BrowserLauncherOptions,
    retryOptions?: Partial<RetryOptions>,
  ): Promise<PlaywrightBrowser> {
    const operation = async () => {
      try {
        return await this.launchInternal(config);
      } catch (error) {
        try {
          await this.pluginManager.onShutdown(ShutdownReason.LAUNCH_FAILURE);
          await this.shutdownHook();
        } catch (e) {
          this.logger.warn(
            `[CDPService] Error during retry cleanup (onShutdown/shutdownHook): ${e}`,
          );
        }
        throw error;
      }
    };

    const result = await this.retryManager.executeWithRetry(
      operation,
      "Browser Launch",
      retryOptions,
    );

    return result.result;
  }

  @traceable
  public async proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.proxyWebSocketHandler) {
      this.logger.info("[CDPService] Using custom WebSocket proxy handler");
      await this.proxyWebSocketHandler(req, socket, head);
      return;
    }

    if (!this.isRunning()) {
      throw new Error(`WebSocket endpoint not available. Ensure the browser is launched first.`);
    }

    const cleanupListeners = () => {
      socket.off("close", cleanupListeners);
      socket.off("error", cleanupListeners);
      this.logger.info("[CDPService] WebSocket connection listeners cleaned up");
    };

    socket.once("close", cleanupListeners);
    socket.once("error", cleanupListeners);

    this.wsProxyServer.ws(
      req,
      socket,
      head,
      {
        target: `ws://127.0.0.1:${env.CDP_REDIRECT_PORT}`,
      },
      (error) => {
        if (error) {
          this.logger.error(`WebSocket proxy error: ${error}`);
          cleanupListeners();
        }
      },
    );

    socket.on("error", (error) => {
      this.logger.error(`Socket error: ${error}`);
      try {
        socket.end();
      } catch (e) {
        this.logger.error(`Error ending socket: ${e}`);
      }
    });
  }

  /**
   * The browser's real user agent. Nothing is spoofed at the service level; a
   * live value is read from the page when callers need one.
   */
  public async getLiveUserAgent(): Promise<string | undefined> {
    try {
      const page = await this.getPrimaryPage();
      return await page.evaluate(() => navigator.userAgent);
    } catch {
      return undefined;
    }
  }

  public getUserAgent(): string | undefined {
    // No spoofed agent: the browser reports itself.
    return undefined;
  }

  public getDimensions() {
    return this.currentSessionConfig?.dimensions || { width: 1920, height: 1080 };
  }

  public async getCookies(): Promise<PlaywrightCookie[]> {
    if (!this.primaryPage) {
      throw new Error("Primary page not initialized");
    }
    return this.primaryPage.context().cookies();
  }

  public async getBrowserState(): Promise<SessionData> {
    if (!this.browserInstance || !this.primaryPage) {
      throw new Error("Browser or primary page not initialized");
    }

    const userDataDir = this.launchConfig?.userDataDir;

    if (!userDataDir) {
      this.logger.warn("No userDataDir specified, returning empty session data");
      return {};
    }

    try {
      this.logger.info(`[CDPService] Dumping session data from userDataDir: ${userDataDir}`);

      const [cookieData, sessionData, storageData] = await Promise.all([
        this.getCookies().catch(() => []),
        this.chromeSessionService
          .getSessionData(userDataDir)
          .catch(() => ({}) as SessionData),
        this.getExistingPageSessionData(),
      ]);

      const result = {
        cookies: cookieData as any,
        localStorage: {
          ...(sessionData.localStorage || {}),
          ...(storageData.localStorage || {}),
        },
        sessionStorage: {
          ...(sessionData.sessionStorage || {}),
          ...(storageData.sessionStorage || {}),
        },
        indexedDB: {
          ...(sessionData.indexedDB || {}),
          ...(storageData.indexedDB || {}),
        },
      };

      this.logger.info("[CDPService] Session data dumped successfully");
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[CDPService] Error dumping session data: ${errorMessage}`);
      return {};
    }
  }

  private async getExistingPageSessionData(): Promise<SessionData> {
    if (!this.browserInstance || !this.primaryPage) {
      return {};
    }

    const result: SessionData = {
      localStorage: {},
      sessionStorage: {},
      indexedDB: {},
    };

    try {
      const pages = (await (this.browserInstance as any).pages()) as PlaywrightPage[];

      let crashedCount = 0;
      const validPages = pages.filter((page) => {
        try {
          if (this.crashedPages.has(page)) {
            crashedCount++;
            return false;
          }
          const url = page.url();
          return url && url.startsWith("http");
        } catch (e) {
          return false;
        }
      });

      this.logger.info(
        `[CDPService] Processing ${validPages.length} valid pages out of ${pages.length} total for storage extraction` +
          (crashedCount > 0 ? ` (skipped ${crashedCount} crashed)` : ""),
      );

      const results = await Promise.all(
        validPages.map((page) => extractStorageForPageWithTimeout(page as any, this.logger)),
      );

      for (const item of results) {
        for (const domain in item.localStorage) {
          result.localStorage![domain] = {
            ...(result.localStorage![domain] || {}),
            ...item.localStorage![domain],
          };
        }

        for (const domain in item.sessionStorage) {
          result.sessionStorage![domain] = {
            ...(result.sessionStorage![domain] || {}),
            ...item.sessionStorage![domain],
          };
        }

        for (const domain in item.indexedDB) {
          result.indexedDB![domain] = [
            ...(result.indexedDB![domain] || []),
            ...item.indexedDB![domain],
          ];
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`[CDPService] Error extracting storage with CDP: ${error}`);
      return result;
    }
  }

  public async getAllPages(): Promise<PlaywrightPage[]> {
    if (!this.browserInstance) return [];
    try {
      return (await (this.browserInstance as any).pages()) as PlaywrightPage[];
    } catch {
      return [];
    }
  }

  @traceable
  public async startNewSession(sessionConfig: BrowserLauncherOptions): Promise<PlaywrightBrowser> {
    this.currentSessionConfig = sessionConfig;
    this.sessionContext = null;
    this.trackedOrigins.clear();

    this.targetInstrumentationManager = new TargetInstrumentationManager(
      this.instrumentationLogger,
      this.logger,
      {
        dangerouslyLogRequestDetails: sessionConfig.dangerouslyLogRequestDetails,
        captureWorkerNetwork: sessionConfig.captureWorkerNetwork,
      },
    );

    await this.pluginManager.onSessionStart(sessionConfig);

    try {
      return await this.launch(sessionConfig);
    } catch (error) {
      await this.pluginManager.onBeforeSessionEnd(sessionConfig);
      await this.pluginManager.onSessionEnd(sessionConfig);
      await this.pluginManager.onAfterSessionEnd(sessionConfig);
      throw error;
    }
  }

  @traceable
  public async endSession(
    reason: ShutdownReason = ShutdownReason.SESSION_END,
    options?: { relaunchIdle?: boolean },
  ): Promise<void> {
    this.logger.info("Ending current session and resetting to default configuration.");
    const sessionConfig = this.currentSessionConfig;

    // getBrowserState dumps cookies/storage over CDP; bound it so a dying
    // browser cannot stall session teardown indefinitely.
    this.sessionContext = await Promise.race([
      this.getBrowserState().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    try {
      if (sessionConfig) {
        await this.pluginManager.onBeforeSessionEnd(sessionConfig);
      }
      await this.shutdown(reason);
      if (sessionConfig) {
        await this.pluginManager.onSessionEnd(sessionConfig);
      }
      this.currentSessionConfig = null;
      this.sessionContext = null;
      this.trackedOrigins.clear();

      this.instrumentationLogger.resetContext();

      this.targetInstrumentationManager = new TargetInstrumentationManager(
        this.instrumentationLogger,
        this.logger,
      );
    } finally {
      if (sessionConfig) {
        await this.pluginManager.onAfterSessionEnd(sessionConfig);
      }
    }

    if (options?.relaunchIdle) {
      await this.launch(this.defaultLaunchConfig);
    }
  }

  private async onDisconnect(): Promise<void> {
    this.logger.info("Browser disconnected. Handling cleanup.");

    if (this.shuttingDown) {
      this.browserInstance = null;
      this.primaryPage = null as any;
      return;
    }

    this.browserInstance = null;
    this.primaryPage = null as any;
    try {
      await this.disconnectHandler();
    } catch (err) {
      this.logger.warn({ err }, "disconnectHandler error");
    }
  }

  @traceable
  private async injectSessionContext(
    page: PlaywrightPage,
    context?: BrowserLauncherOptions["sessionContext"],
  ) {
    if (!context) return;

    const storageByOrigin = groupSessionStorageByOrigin(context as any);

    for (const origin of storageByOrigin.keys()) {
      this.trackedOrigins.add(origin);
    }

    const client = await (page.context() as any).newCDPSession(page);
    try {
      if (context.cookies?.length) {
        await client.send("Network.setCookies", {
          cookies: context.cookies.map((cookie) => ({
            ...cookie,
            partitionKey: (cookie as any).partitionKey,
          })),
        });
        this.logger.info(`[CDPService] Set ${context.cookies.length} cookies`);
      }
    } catch (error) {
      this.logger.error(`[CDPService] Error setting cookies: ${error}`);
    } finally {
      await client.detach().catch(() => {});
    }

    this.logger.info(
      `[CDPService] Registered frame navigation handler for ${storageByOrigin.size} origins`,
    );
    page.on("framenavigated", (frame) => handleFrameNavigated(frame as any, storageByOrigin, this.logger));

    page.context().on("page", (newPage: PlaywrightPage) => {
      try {
        newPage.on("framenavigated", (frame) =>
          handleFrameNavigated(frame as any, storageByOrigin, this.logger),
        );
      } catch (err) {
        this.logger.error(`[CDPService] Error adding framenavigated handler to new page: ${err}`);
      }
    });

    this.logger.debug("[CDPService] Session context injection setup complete");
  }

  @traceable
  private async setupUserPreferences(userDataDir: string, userPreferences: Record<string, any>) {
    try {
      const preferencesPath = getProfilePath(userDataDir, "Preferences");
      const defaultProfileDir = path.dirname(preferencesPath);

      await fs.promises.mkdir(defaultProfileDir, { recursive: true });

      let existingPreferences = {};

      try {
        const existingContent = await fs.promises.readFile(preferencesPath, "utf8");
        existingPreferences = JSON.parse(existingContent);
      } catch (error) {
        this.logger.debug(`[CDPService] No existing preferences found, creating new: ${error}`);
      }

      const mergedPreferences = deepMerge(existingPreferences, userPreferences);

      await fs.promises.writeFile(preferencesPath, JSON.stringify(mergedPreferences, null, 2));

      this.logger.info(`[CDPService] User preferences written to ${preferencesPath}`);
    } catch (error) {
      this.logger.error(`[CDPService] Error setting up user preferences: ${error}`);
      throw error;
    }
  }
}
