import type { Page, Frame } from "patchright";
import {
  SessionData,
  IndexedDBDatabase,
  IndexedDBObjectStore,
  IndexedDBRecord,
  SessionStorageData,
  LocalStorageData,
} from "../services/context/types.js";
import { FastifyBaseLogger } from "fastify";
import { BrowserLauncherOptions } from "../types/index.js";
import path from "path";

// Storage extraction talks to the renderer, which can stop answering without ever
// rejecting, so bound each page rather than let one stall session teardown.
export const STORAGE_EXTRACTION_TIMEOUT_MS = 10_000;

export function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "unknown";
  }
}

function emptySessionData(): SessionData {
  return { localStorage: {}, sessionStorage: {}, indexedDB: {} };
}

// Resolves to empty data if the renderer does not answer in time, and never rejects,
// so a single unresponsive page cannot fail the whole release.
export async function extractStorageForPageWithTimeout(
  page: Page,
  logger: FastifyBaseLogger,
  timeoutMs: number = STORAGE_EXTRACTION_TIMEOUT_MS,
): Promise<SessionData> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      extractStorageForPage(page, logger),
      new Promise<SessionData>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(
            `[CDPService] Storage extraction timed out after ${timeoutMs}ms for ${safePageUrl(
              page,
            )}; skipping page`,
          );
          resolve(emptySessionData());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Extract storage data for a single page
 * @param page patchright page
 * @returns Storage data for the page
 */
export async function extractStorageForPage(
  page: Page,
  logger: FastifyBaseLogger,
): Promise<SessionData> {
  const result: SessionData = {
    localStorage: {},
    sessionStorage: {},
    indexedDB: {},
  };

  try {
    // Skip pages that aren't valid or don't have a proper URL
    const url = page.url();
    if (!url || !url.startsWith("http")) {
      return result;
    }

    // Extract origin and domain from URL
    const origin = new URL(url).origin;
    const domain = new URL(url).hostname;

    const client = await (page.context() as any).newCDPSession(page);

    try {
      // Check if the page has a valid main frame
      const { frameTree } = await client
        .send("Page.getFrameTree")
        .catch(() => ({ frameTree: null }));
      if (!frameTree) {
        logger.debug(`[CDPService] Page has no valid frame tree for ${domain}`);
        return result;
      }

      // Get localStorage using CDP
      try {
        const localStorageResponse = await client.send("DOMStorage.getDOMStorageItems", {
          storageId: { securityOrigin: origin, isLocalStorage: true },
        });

        if (localStorageResponse?.entries?.length) {
          result.localStorage![domain] = {};
          for (const [key, value] of localStorageResponse.entries) {
            result.localStorage![domain][key] = value;
          }
        }
      } catch (err) {
        // Lower log level to avoid flooding logs with expected errors
        logger.trace(`[CDPService] Could not get localStorage for ${domain}: ${err}`);
      }

      // Get sessionStorage (note: only works for active pages)
      try {
        const sessionStorageResponse = await client.send("DOMStorage.getDOMStorageItems", {
          storageId: { securityOrigin: origin, isLocalStorage: false },
        });

        if (sessionStorageResponse?.entries?.length) {
          result.sessionStorage![domain] = {};
          for (const [key, value] of sessionStorageResponse.entries) {
            result.sessionStorage![domain][key] = value;
          }
        }
      } catch (err) {
        // Lower log level to avoid flooding logs with expected errors
        logger.trace(`[CDPService] Could not get sessionStorage for ${domain}: ${err}`);
      }

      // Get IndexedDB databases
      try {
        const dbResponse = await client.send("IndexedDB.requestDatabaseNames", {
          securityOrigin: origin,
        });

        const databaseNames = dbResponse?.databaseNames || [];

        if (databaseNames.length) {
          result.indexedDB![domain] = [];

          for (let dbIndex = 0; dbIndex < databaseNames.length; dbIndex++) {
            const dbName = databaseNames[dbIndex];

            const database: IndexedDBDatabase = {
              id: dbIndex,
              name: dbName,
              data: [],
            };

            const dbSchemaResponse = await client.send("IndexedDB.requestDatabase", {
              securityOrigin: origin,
              databaseName: dbName,
            });

            const objectStores = dbSchemaResponse?.databaseWithObjectStores?.objectStores || [];

            for (let storeIndex = 0; storeIndex < objectStores.length; storeIndex++) {
              const store = objectStores[storeIndex];

              const objectStore: IndexedDBObjectStore = {
                id: storeIndex,
                name: store.name,
                records: [],
              };

              let hasMoreData = true;
              let skipCount = 0;
              const pageSize = 1000;

              while (hasMoreData) {
                const dataResponse = await client.send("IndexedDB.requestData", {
                  securityOrigin: origin,
                  databaseName: dbName,
                  objectStoreName: store.name,
                  indexName: "", // Empty string means use primary key
                  skipCount,
                  pageSize,
                });

                const objectStoreData = dataResponse?.objectStoreDataEntries || [];
                if (objectStoreData.length) {
                  const records: IndexedDBRecord[] = objectStoreData.map((entry) => ({
                    key: entry.key,
                    value: entry.value,
                  }));

                  objectStore.records.push(...records);
                }

                hasMoreData = !!dataResponse?.hasMore;
                skipCount += objectStoreData.length;

                // Safety check to prevent infinite loops
                if (objectStoreData.length === 0) break;
              }

              database.data.push(objectStore);
            }

            result.indexedDB![domain].push(database);
          }
        }
      } catch (err) {
        // Lower log level to avoid flooding logs with expected errors
        logger.trace(`[CDPService] Could not get IndexedDB for ${domain}: ${err}`);
      }
    } finally {
      // Always ensure the client session is detached
      await client.detach().catch(() => {});
    }
  } catch (err) {
    logger.warn(`[CDPService] Error extracting storage for page: ${err}`);
  }

  return result;
}

// Create our frameNavigated handler
export const handleFrameNavigated = async (
  frame: Frame,
  storageByOrigin: Map<
    string,
    {
      localStorage?: LocalStorageData;
      sessionStorage?: SessionStorageData;
      indexedDB?: IndexedDBDatabase[];
    }
  >,
  logger: FastifyBaseLogger,
) => {
  // Only process top-level frames
  if (frame.parentFrame()) return;

  try {
    const url = frame.url();
    if (!url || !url.startsWith("http")) return;

    const origin = new URL(url).origin;

    const storage = storageByOrigin.get(origin);
    if (!storage) return;

    logger.debug(`[CDPService] Injecting storage for navigated origin: ${origin}`);

    if (storage.localStorage) {
      await frame.evaluate((items: LocalStorageData) => {
        for (const [key, value] of Object.entries(items)) {
          try {
            if (typeof value === "string") {
              localStorage.setItem(key, value);
            }
          } catch (e) {
            console.error(`Error setting localStorage: ${e}`);
          }
        }
      }, storage.localStorage);
    }

    if (storage.sessionStorage) {
      await frame.evaluate((items: SessionStorageData) => {
        for (const [key, value] of Object.entries(items)) {
          try {
            if (typeof value === "string") {
              sessionStorage.setItem(key, value);
            }
          } catch (e) {
            console.error(`Error setting sessionStorage: ${e}`);
          }
        }
      }, storage.sessionStorage);
    }

    if (storage.indexedDB && storage.indexedDB.length > 0) {
      for (const database of storage.indexedDB) {
        if (!database.name || !database.data) continue;

        const storeMap: Record<string, any[]> = {};

        for (const store of database.data) {
          if (!store.name || !store.records || store.records.length === 0) continue;

          storeMap[store.name] = store.records.map((record) => {
            try {
              const parsedKey = typeof record.key === "string" ? JSON.parse(record.key) : record.key;
              const parsedValue =
                typeof record.value === "string" ? JSON.parse(record.value) : record.value;
              return { key: parsedKey, value: parsedValue };
            } catch (e) {
              return { key: record.key, value: record.value };
            }
          });
        }

        if (Object.keys(storeMap).length === 0) continue;

        await frame.evaluate(
          // @ts-expect-error patchright's evaluate overloads only accept one arg on this signature
          async (dbName: string, stores: Record<string, any[]>) => {
            return new Promise((resolve, reject) => {
              try {
                const openRequest = indexedDB.open(dbName, 1);

                openRequest.onupgradeneeded = function (event) {
                  const db = (event.target as IDBOpenDBRequest).result;

                  for (const storeName of Object.keys(stores)) {
                    if (!db.objectStoreNames.contains(storeName)) {
                      db.createObjectStore(storeName, { keyPath: "key" });
                    }
                  }
                };

                openRequest.onsuccess = function (event) {
                  const db = (event.target as IDBOpenDBRequest).result;
                  let completedStores = 0;
                  const totalStores = Object.keys(stores).length;

                  for (const [storeName, storeData] of Object.entries(stores)) {
                    if (!db.objectStoreNames.contains(storeName)) {
                      completedStores++;
                      continue;
                    }

                    const transaction = db.transaction(storeName, "readwrite");
                    const objectStore = transaction.objectStore(storeName);

                    for (const item of storeData as any[]) {
                      try {
                        objectStore.put(item);
                      } catch (e) {
                        console.error(`Error adding item to IndexedDB: ${e}`);
                      }
                    }

                    transaction.oncomplete = function () {
                      completedStores++;
                      if (completedStores === totalStores) {
                        resolve(true);
                      }
                    };
                    transaction.onerror = function (err) {
                      console.error(`Transaction error: ${err}`);
                      completedStores++;
                      if (completedStores === totalStores) {
                        resolve(false);
                      }
                    };
                  }

                  if (totalStores === 0) {
                    resolve(true);
                  }
                };

                openRequest.onerror = function (event) {
                  reject(`Error opening IndexedDB: ${(event.target as IDBOpenDBRequest).error}`);
                };
              } catch (e) {
                reject(`IndexedDB restore error: ${e}`);
              }
            });
          },
          database.name,
          storeMap,
        );
      }
    }
  } catch (err) {
    logger.error(`[CDPService] Error injecting storage during navigation: ${err}`);
  }
};

/**
 * Organizes session storage data by origin for efficient lookup
 * @param context Session context data from BrowserLauncherOptions
 * @returns Map of origins to their storage data
 */
export function groupSessionStorageByOrigin(
  context?: BrowserLauncherOptions["sessionContext"],
): Map<
  string,
  {
    localStorage?: LocalStorageData;
    sessionStorage?: SessionStorageData;
    indexedDB?: IndexedDBDatabase[];
  }
> {
  const result = new Map<
    string,
    {
      localStorage?: LocalStorageData;
      sessionStorage?: SessionStorageData;
      indexedDB?: IndexedDBDatabase[];
    }
  >();

  if (!context) return result;

  if (context.localStorage) {
    for (const [domain, storage] of Object.entries(context.localStorage)) {
      if (!result.has(domain)) {
        result.set(domain, {});
      }
      result.get(domain)!.localStorage = storage;
    }
  }

  if (context.sessionStorage) {
    for (const [domain, storage] of Object.entries(context.sessionStorage)) {
      if (!result.has(domain)) {
        result.set(domain, {});
      }
      result.get(domain)!.sessionStorage = storage;
    }
  }

  if (context.indexedDB) {
    for (const [domain, databases] of Object.entries(context.indexedDB)) {
      if (!result.has(domain)) {
        result.set(domain, {});
      }
      result.get(domain)!.indexedDB = databases;
    }
  }

  return result;
}

/**
 * Helper to get Chrome profile paths in a cross-platform way
 * Takes into account different Chrome profile directory structures
 */
export function getProfilePath(userDataDir: string, ...pathSegments: string[]): string {
  // Chrome profile directories vary by platform and version
  // Both "Default" and "Profile 1" are standard locations
  const possibleProfileDirs = ["Default", "Profile 1"];

  const dirName = path.basename(userDataDir);
  if (possibleProfileDirs.includes(dirName)) {
    return path.join(userDataDir, ...pathSegments);
  }

  return path.join(userDataDir, "Default", ...pathSegments);
}

/**
 * Deep merge two objects, with the second object taking precedence.
 * Arrays are replaced entirely, not merged.
 */
export function deepMerge<T = any>(target: T, source: Partial<T>): T {
  if (typeof target !== "object" || target === null) {
    return source as T;
  }
  if (typeof source !== "object" || source === null) {
    return target;
  }

  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      const sourceValue = source[key];
      const targetValue = (result as any)[key];

      if (typeof sourceValue === "object" && sourceValue !== null && !Array.isArray(sourceValue)) {
        (result as any)[key] = deepMerge(targetValue, sourceValue);
      } else {
        (result as any)[key] = sourceValue;
      }
    }
  }

  return result;
}
