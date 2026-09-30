import { IncomingMessage } from "http";
import { Duplex } from "stream";
import WebSocket, { Server } from "ws";

import type { BrowserContext, CDPSession, Page } from "patchright";
import { env } from "../../env.js";
import { SessionService } from "../../services/session.service.js";
import {
  CloseTabEvent,
  GetSelectedTextEvent,
  KeyEvent,
  MouseEvent,
  NavigationEvent,
  PageInfo,
} from "../../types/casting.js";
import { getPageFavicon, getPageTitle, navigatePage } from "../../utils/casting.js";
import { getSessionCdpPort } from "../../utils/nodriver-client.js";

export async function handleCastSession(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: Server,
  sessionService: SessionService,
  params: Record<string, string> | undefined,
): Promise<void> {
  const id = request.url?.split("/sessions/")[1].split("/cast")[0];

  if (!id) {
    console.error("Cast Session ID not found");
    socket.destroy();
    return;
  }

  const session = await sessionService.activeSession;
  if (!session) {
    console.error(`Cast Session ${id} not found`);
    socket.destroy();
    return;
  }

  const queryParams = new URLSearchParams(request.url?.split("?")[1] || "");
  const requestedPageId = params?.pageId || queryParams.get("pageId") || null;
  const requestedPageIndex = params?.pageIndex || queryParams.get("pageIndex") || null;

  // Isolated scrape jobs: ?sessionId=<id> means "cast THAT job's private
  // browser", not the shared session browser. Each job runs nodriver on its
  // own free CDP port, so attach by port (falling back to the shared one).
  const jobId = queryParams.get("sessionId") || null;
  const job = jobId ? sessionService.getRunningScrapeJob(jobId) : undefined;
  const cdpPort = job ? job.cdpPort || getSessionCdpPort() : getSessionCdpPort();

  const tabDiscoveryMode =
    queryParams.get("tabInfo") === "true" || (!requestedPageId && !requestedPageIndex);

  const isMobile = session.deviceConfig?.device === "mobile";
  const defaultDimensions = isMobile ? { width: 508, height: 1074 } : { width: 1920, height: 1080 };
  const { height, width } =
    (session.dimensions as { width: number; height: number }) ?? defaultDimensions;

  const resolvePageId = async (page: Page): Promise<string> => {
    const cached = (page as any).__steelPageId;
    if (cached) return cached;
    try {
      const client = await (page.context() as any).newCDPSession(page);
      const { targetInfo } = await client.send("Target.getTargetInfo");
      await client.detach().catch(() => {});
      (page as any).__steelPageId = targetInfo.targetId;
      return targetInfo.targetId;
    } catch {
      return page.url();
    }
  };

  wss.handleUpgrade(request, socket, head, async (ws) => {
    let context: BrowserContext | null = null;
    let targetPage: Page | null = null;
    let targetClient: CDPSession | null = null;
    let targetPageId: string | null = null;

    const activePages = new Map<string, Page>();

    let heartbeatInterval: NodeJS.Timeout | null = null;

    const handleSessionCleanup = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      if (targetPage) {
        targetPage.removeAllListeners("framenavigated");
      }

      // Clean up screencast
      if (targetClient) {
        try {
          targetClient.send("Page.stopScreencast").catch(() => {});
          targetClient.detach().catch(() => {});
          targetClient = null;
        } catch (err) {
          console.error("Error during screencast cleanup:", err);
        }
      }

      // Disconnect our own CDP connection (does not close the browser)
      if (context) {
        try {
          context.close().catch(() => {});
          context = null;
        } catch (err) {
          console.error("Error during context disconnect:", err);
        }
      }

      if (global.gc) {
        try {
          global.gc();
        } catch (err) {
          console.error("Error during garbage collection:", err);
        }
      }
    };

    const sendTabList = async () => {
      try {
        if (ws.readyState !== WebSocket.OPEN || !tabDiscoveryMode) return;

        const tabList: PageInfo[] = [];

        for (const [pageId, page] of activePages.entries()) {
          tabList.push({
            id: pageId,
            url: page.url(),
            title: await getPageTitle(page as any),
            favicon: await getPageFavicon(page as any),
          });
        }

        ws.send(
          JSON.stringify({
            type: "tabList",
            tabs: tabList,
            firstTabId: tabList.length > 0 ? tabList[0].id : null,
          }),
        );
      } catch (error) {
        console.error("Error sending tab list:", error);
      }
    };

    const findTargetPage = async (
      pages: Page[],
    ): Promise<{ page: Page; pageId: string } | null> => {
      if (tabDiscoveryMode) return null;

      if (requestedPageId) {
        for (const page of pages) {
          const pageId = await resolvePageId(page);
          if (pageId === requestedPageId) {
            return { page, pageId };
          }
        }
      } else if (requestedPageIndex) {
        const index = parseInt(requestedPageIndex, 10);
        if (index >= 0 && index < pages.length) {
          const page = pages[index];
          return { page, pageId: await resolvePageId(page) };
        }
      }

      return null;
    };

    try {
      // Attach to the running browser over its CDP websocket (patchright).
      // nodriver picks a fresh CDP port per launch — use the live one. For an
      // isolated scrape job, that is the job's own port, not the shared one.
      const { chromium } = await import("patchright");
      const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${cdpPort || env.CDP_REDIRECT_PORT}`,
      );
      const contexts = browser.contexts();
      context = contexts[0] ?? (await browser.newContext());

      const pages = await context.pages();

      if (tabDiscoveryMode) {
        for (const page of pages) {
          activePages.set(await resolvePageId(page), page);
        }

        await sendTabList();

        context.on("page", async (page) => {
          try {
            activePages.set(await resolvePageId(page), page);
            await sendTabList();
          } catch (err) {
            console.error("Error handling new target:", err);
          }
        });

        context.on("close", async () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "targetClosed", pageId: null }));
          }
        });

        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (err) {
              console.error("Error sending ping:", err);
              handleSessionCleanup();
            }
          } else {
            handleSessionCleanup();
          }
        }, 30000);

        ws.on("close", () => handleSessionCleanup());
        ws.on("error", (err) => {
          console.error("Tab discovery WebSocket error:", err);
          handleSessionCleanup();
        });

        return;
      }

      const targetResult = await findTargetPage(pages);
      if (!targetResult) {
        console.error(
          `Target page not found for ${
            requestedPageId ? `pageId=${requestedPageId}` : `pageIndex=${requestedPageIndex}`
          }`,
        );
        socket.destroy();
        return;
      }

      targetPage = targetResult.page;
      targetPageId = targetResult.pageId;

      await targetPage.bringToFront().catch(() => {});

      targetClient = await context.newCDPSession(targetPage);

      ws.on("message", async (message) => {
        try {
          const data:
            | MouseEvent
            | KeyEvent
            | NavigationEvent
            | CloseTabEvent
            | GetSelectedTextEvent = JSON.parse(message.toString());
          const { type } = data;

          if (!targetClient || !targetPage) {
            console.error("No target page or client available for input handling");
            return;
          }

          switch (type) {
            case "mouseEvent": {
              const { event } = data as MouseEvent;
              await targetClient.send("Input.dispatchMouseEvent", {
                type: event.type,
                x: event.x,
                y: event.y,
                button: event.button,
                buttons: event.button === "none" ? 0 : 1,
                clickCount: event.clickCount || 1,
                modifiers: event.modifiers || 0,
                deltaX: event.deltaX,
                deltaY: event.deltaY,
              });
              break;
            }
            case "keyEvent": {
              const { event } = data as KeyEvent;
              await targetClient.send("Input.dispatchKeyEvent", {
                type: event.type,
                text: event.text,
                unmodifiedText: event.text ? event.text.toLowerCase() : undefined,
                code: event.code,
                key: event.key,
                windowsVirtualKeyCode: event.keyCode,
                nativeVirtualKeyCode: event.keyCode,
                modifiers: event.modifiers || 0,
                autoRepeat: false,
                isKeypad: false,
                isSystemKey: false,
              });
              break;
            }
            case "navigation": {
              const { event } = data as NavigationEvent;
              await navigatePage(event, targetPage as any);
              break;
            }
            case "closeTab": {
              await targetPage?.close();
              if ((data as CloseTabEvent).pageId) {
                activePages.delete((data as CloseTabEvent).pageId);
              }
              break;
            }
            case "getSelectedText": {
              try {
                const selectedText = await targetPage.evaluate(() => {
                  const selection = window.getSelection();
                  return selection ? selection.toString() : "";
                });

                ws.send(
                  JSON.stringify({
                    type: "selectedTextResponse",
                    pageId: (data as GetSelectedTextEvent).pageId,
                    text: selectedText,
                  }),
                );
              } catch (error) {
                console.error("Failed to get selected text:", error);
                ws.send(
                  JSON.stringify({
                    type: "selectedTextResponse",
                    pageId: (data as GetSelectedTextEvent).pageId,
                    text: "",
                    error: error instanceof Error ? error.message : "Unknown error",
                  }),
                );
              }
              break;
            }

            default:
              console.warn("Unknown event type:", type);
          }
        } catch (err) {
          console.error("Error handling WebSocket message:", err);
        }
      });

      // Setup device metrics and start screencast
      await targetClient.send("Page.setDeviceMetricsOverride", {
        screenHeight: height,
        screenWidth: width,
        width,
        height,
        mobile: isMobile,
        screenOrientation: isMobile
          ? { angle: 0, type: "portraitPrimary" }
          : { angle: 90, type: "landscapePrimary" },
        deviceScaleFactor: isMobile ? 3 : 1,
      });

      await targetClient.send("Page.startScreencast", {
        format: "jpeg",
        quality: 75,
        maxWidth: width,
        maxHeight: height,
      });

      targetClient.on("Page.screencastFrame", async ({ data, sessionId }: any) => {
        try {
          await targetClient?.send("Page.screencastFrameAck", { sessionId });

          if (ws.readyState === WebSocket.OPEN) {
            const title = await getPageTitle(targetPage as any);
            const favicon = await getPageFavicon(targetPage as any);

            ws.send(
              JSON.stringify({
                pageId: targetPageId,
                url: targetPage?.url(),
                title,
                favicon,
                data,
              }),
            );
          }
        } catch (err) {
          console.error("Error in Page.screencastFrame handler:", err);
        }
      });

      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (err) {
            console.error("Error sending ping:", err);
            handleSessionCleanup();
          }
        } else {
          handleSessionCleanup();
        }
      }, 30000);

      ws.on("close", () => handleSessionCleanup());
      ws.on("error", (err) => {
        console.error("Cast WebSocket error:", err);
        handleSessionCleanup();
      });
    } catch (err) {
      console.error("Error in cast session:", err);
      handleSessionCleanup();
      socket.destroy();
    }
  });
}
