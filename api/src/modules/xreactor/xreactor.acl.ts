/**
 * Access control for the /xreactor endpoint.
 *
 * Two layers keep the endpoint isolated from the rest of the API:
 *
 *   1. Host isolation (always on):
 *      - /xreactor only answers requests whose Host header is the allowed
 *        domain (xreactor-bot.duckdns.org by default, HTTP via Caddy).
 *      - A global hook (registered in index.ts) rejects every OTHER route
 *        when the request arrives under that same Host, so the domain can
 *        never reach sessions/scrape/UI traffic and vice versa.
 *
 *   2. Shared-secret edge header (optional, recommended):
 *      When XREACTOR_EDGE_TOKEN is set, /xreactor additionally requires the
 *      `x-xreactor-edge` header to match. Caddy injects it via
 *      `header_up`, which stops anyone from bypassing the domain by
 *      spoofing the Host header directly against IP:3000.
 */

const DEFAULT_ALLOWED_HOST = "xreactor-bot.duckdns.org";
export const XREACTOR_EDGE_HEADER = "x-xreactor-edge";

export function xreactorAllowedHost(): string {
  const raw = process.env.XREACTOR_ALLOWED_HOST || DEFAULT_ALLOWED_HOST;
  return raw.trim().toLowerCase();
}

/** Extracts just the hostname from a Host header (strips port, case, proxies). */
export function hostOf(headerValue: string | undefined | string[]): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return (raw || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .split(":")[0];
}

export function hostIsXReactor(headerValue: string | undefined | string[]): boolean {
  const host = hostOf(headerValue);
  return host.length > 0 && host === xreactorAllowedHost();
}

/** True when the request path targets the /xreactor endpoint (any subpath). */
export function isXReactorPath(rawUrl: string | undefined): boolean {
  const path = (rawUrl || "/").split("?")[0].split("#")[0];
  return path === "/xreactor" || path.startsWith("/xreactor/");
}

/** Edge shared-secret check: no-op unless XREACTOR_EDGE_TOKEN is configured. */
export function edgeTokenOk(headerValue: string | undefined | string[] | undefined): boolean {
  const expected = process.env.XREACTOR_EDGE_TOKEN;
  if (!expected) return true;
  const got = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof got === "string" && got === expected;
}
