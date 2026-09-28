import { z } from "zod";

/**
 * API/WS base URLs.
 *
 * - Explicitly set VITE_* vars always win (including empty string = same origin,
 *   which is how setup.sh builds the UI embedded in the API).
 * - Unset vars fall back at runtime: same-origin in production builds (the API
 *   serves the UI at /ui), and the nginx-style /api + /ws proxy paths in dev.
 *   This keeps a forgotten env var from baking a dead "/api" prefix into the
 *   production bundle.
 */
const isProd = !!import.meta.env.PROD;

const envSchema = z.object({
  VITE_API_URL: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? (isProd ? "" : "/api") : val)),
  VITE_WS_URL: z
    .string()
    .optional()
    .transform((val) =>
      val === undefined ? (isProd ? apiBaseToWs("") : "/ws") : val,
    ),
});

/** Build an absolute WebSocket base from an HTTP-style base (or same origin). */
export function apiBaseToWs(base: string): string {
  if (base.startsWith("ws://") || base.startsWith("wss://")) return base;
  if (typeof window === "undefined") return base;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const origin = `${proto}//${window.location.host}`;
  if (!base) return origin;
  if (base.startsWith("http://") || base.startsWith("https://")) {
    return base.replace(/^http/, "ws");
  }
  return `${origin}${base}`;
}

/** Resolve `base + path` to an absolute WebSocket URL (relative URLs throw in browsers). */
export function toWsUrl(base: string, path: string): string {
  const wsBase = apiBaseToWs(base);
  return `${wsBase}${path}`;
}

export const env = envSchema.parse(import.meta.env);
