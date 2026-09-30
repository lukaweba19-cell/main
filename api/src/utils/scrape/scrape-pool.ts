/**
 * Limits concurrent scrape jobs and tracks in-flight count so the browser
 * can be shut down only after the queue has been idle for a grace period.
 */
export class ScrapePool {
  private active = 0;
  private waiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly maxConcurrency: number,
    /** ms to wait after last job before calling onIdle */
    private readonly idleShutdownMs = 15_000,
  ) {
    if (maxConcurrency < 1) {
      throw new Error("maxConcurrency must be >= 1");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get max(): number {
    return this.maxConcurrency;
  }

  private acquireSlot(): Promise<void> {
    // New work cancels pending idle shutdown
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.generation += 1;

    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
    if (this.active === 0) {
      const idle = this.idleWaiters.splice(0);
      idle.forEach((fn) => fn());
    }
  }

  /** Run fn under the concurrency limit. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Schedule onIdle after the pool has been empty for idleShutdownMs.
   * Cancelled automatically if a new job starts.
   */
  scheduleIdleShutdown(onIdle: () => void | Promise<void>): void {
    if (this.active !== 0) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const gen = this.generation;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Abort if any work started (or finished another cycle) since schedule
      if (this.active !== 0 || this.generation !== gen) return;
      Promise.resolve(onIdle()).catch(() => {});
    }, this.idleShutdownMs);
  }

  whenIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}

const max = Math.max(1, parseInt(process.env.SCRAPE_MAX_CONCURRENCY || "4", 10) || 4);
const idleMs = Math.max(0, parseInt(process.env.SCRAPE_IDLE_SHUTDOWN_MS || "15000", 10) || 15000);
export const scrapePool = new ScrapePool(max, idleMs);
