import { describe, expect, it, vi } from "vitest";

vi.mock("../env.js", () => ({ env: {} }));
vi.mock("./timezone-fetcher.service.js", () => ({
  TimezoneFetcher: class {},
}));

import { IProxyServer } from "../utils/proxy.js";
import { SessionService } from "./session.service.js";

/**
 * A proxy whose byte counters settle when it closes, mirroring proxy-chain: a
 * connection is credited on `connectionClosed`, and a long-lived tunnel stays
 * open until the browser goes away.
 */
function createProxyServer() {
  const proxy: IProxyServer & { close: ReturnType<typeof vi.fn> } = {
    url: "http://127.0.0.1:0",
    upstreamProxyUrl: "",
    txBytes: 1_000,
    rxBytes: 2_000,
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      Object.assign(proxy, { txBytes: 3_000, rxBytes: 400_000 });
    }),
  };
  return proxy;
}

function createService({ withProxy = false } = {}) {
  const cdpService = {
    getUserAgent: () => "test-agent",
    getLiveUserAgent: async () => "test-agent",
    getDimensions: () => ({ width: 1920, height: 1080 }),
    endSession: vi.fn().mockResolvedValue(undefined),
    startNewSession: vi.fn().mockResolvedValue(undefined),
  };
  const service = new SessionService({
    cdpService: cdpService as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });

  const proxy = withProxy ? createProxyServer() : undefined;
  if (proxy) service.activeSession.proxyServer = proxy;

  return { service, cdpService, proxy };
}

describe("SessionService running scrape jobs (live dashboard rows)", () => {
  it("registers a running job as a live row and removes it on finish", () => {
    const { service } = createService();

    service.addRunningScrapeJob({
      id: "job-1",
      createdAt: new Date().toISOString(),
      cdpPort: 9333,
      dimensions: { width: 1440, height: 900 },
      logPageId: "job-1",
    });

    const rows = service.getRunningScrapeJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].cdpPort).toBe(9333);

    const live = service.toLiveSessionDetails(rows[0]);
    expect(live.status).toBe("live");
    expect(live.debugUrl).toContain("/v1/sessions/debug");
    expect(live.kind).toBe("scrape");
    expect(live.logPageId).toBe("job-1");

    service.removeRunningScrapeJob("job-1");
    expect(service.getRunningScrapeJobs()).toHaveLength(0);
  });

  it("lists newest jobs first and finds a job by id", () => {
    const { service } = createService();
    for (const id of ["job-a", "job-b", "job-c"]) {
      service.addRunningScrapeJob({
        id,
        createdAt: new Date().toISOString(),
        cdpPort: 0,
      });
    }
    expect(service.getRunningScrapeJobs().map((j) => j.id)).toEqual([
      "job-c",
      "job-b",
      "job-a",
    ]);
    expect(service.getRunningScrapeJob("job-b")?.id).toBe("job-b");
    expect(service.getRunningScrapeJob("missing")).toBeUndefined();
  });
});

describe("SessionService.endSession proxy accounting", () => {
  it("reports the counters the proxy settles on close", async () => {
    const { service, proxy } = createService({ withProxy: true });

    const released = await service.endSession();

    expect(proxy!.close).toHaveBeenCalledTimes(1);
    expect(proxy!.close).toHaveBeenCalledWith(true);
    expect(released.proxyRxBytes).toBe(400_000);
    expect(released.proxyTxBytes).toBe(3_000);
  });

  it("closes the proxy only after the browser is torn down", async () => {
    const order: string[] = [];
    const { service, cdpService, proxy } = createService({ withProxy: true });
    cdpService.endSession.mockImplementation(async () => {
      order.push("cdp");
    });
    proxy!.close.mockImplementation(async () => {
      order.push("proxy");
    });

    await service.endSession();

    expect(order).toEqual(["cdp", "proxy"]);
  });

  it("leaves the counters at zero when the session had no proxy", async () => {
    const { service } = createService();

    const released = await service.endSession();

    expect(released.proxyRxBytes).toBe(0);
    expect(released.proxyTxBytes).toBe(0);
  });
});
