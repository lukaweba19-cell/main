/**
 * XReactor scanning core.
 *
 * 1. Link selection — which anchor hrefs qualify for following. Ads and
 *    trackers (doubleclick, analytics, taboola, outbrain, ...), mail/tel/js/
 *    data schemes, fragment-only links and binary downloads are filtered out.
 *    Links are followed breadth-first from the seed URL with a hard cap on the
 *    number of EXTRA pages visited (beyond the seed) and a per-page cap.
 *
 * 2. Cloud-variant scan — each page's markdown text is checked for "cloud"
 *    and related spellings/variants: plain cloud, leetspeak (cl0ud, cl0ud,
 *    c1oud, c1oud, k1oud...), spaced/kasr (c loud), the German/Dutch style
 *    "kloud", "cloude", "cloudy"/"clouds" via word stems, plus vendor terms
 *    (cloudflare, cloudfront, cloudinary, ...). Any hit => the page (and the
 *    whole check) is disallowed.
 */

/** Max extra pages followed beyond the seed URL. */
export const MAX_EXTRA_PAGES = 3;
/** Max candidate links harvested from any single page. */
export const MAX_LINKS_PER_PAGE = 12;
/** Hard wall-clock budget for the whole crawl (ms) — a failure ceiling only,
 * happy crawls finish far under it. */
export const CRAWL_TOTAL_BUDGET_MS = 120_000;
/** Per-page navigation failure ceiling (ms) — the ready check itself is
 * event-driven and typically takes 1-2s. */
export const PER_PAGE_TIMEOUT_MS = 45_000;

const AD_HOST_PATTERNS = [
  "doubleclick",
  "googlesyndication",
  "google-analytics",
  "googletagmanager",
  "googleadservices",
  "googletagservices",
  "adservice",
  "adnxs",
  "adsystem",
  "adsrvr",
  "adroll",
  "adform",
  "adzerk",
  "adcolony",
  "taboola",
  "outbrain",
  "zedo",
  "criteo",
  "casalemedia",
  "pubmatic",
  "rubiconproject",
  "openx",
  "indexww",
  "smartadserver",
  "moatads",
  "scorecardresearch",
  "quantserve",
  "quantcast",
  "chartbeat",
  "mixpanel",
  "segment.io",
  "segment.com",
  "hotjar",
  "crazyegg",
  "optimizely",
  "newrelic",
  "nr-data",
  "bugsnag",
  "sentry",
  "facebook",
  "connect.facebook",
  "twitter",
  "x.com",
  "linkedin",
  "tiktok",
  "pinterest",
  "reddit.com",
  "disqus",
  "gravatar",
  // Messaging / social app links: these pages auto-trigger external protocol
  // handlers (tg://, whatsapp://, ...) which pop native "Open xdg-open?"
  // dialogs that stall headful checks. Never follow them.
  "t.me",
  "telegram.me",
  "telegram.org",
  "telegram.dog",
  "tx.me",
  "wa.me",
  "whatsapp.com",
  "m.me",
  "messenger.com",
  "discord",
  "slack.com",
  "instagram.com",
  "snapchat.com",
  "vk.com",
  "viber.com",
  "signal.org",
  "line.me",
  "threema",
  "wire.com",
  "youtube",
  "ytimg",
  "vimeo",
  "amazon-adsystem",
  "amzn",
  "clickbank",
  "adclick",
  "adsense",
];

/** Hostname segments that mark a host as ad/track infrastructure. */
const AD_HOST_SEGMENTS = new Set([
  "ads", "ad", "adservice", "adsystem", "adserver", "advert", "advertising",
  "banners", "banner", "sponsor", "sponsored", "track", "tracker", "tracking",
  "analytics", "metrics", "telemetry", "pixel", "pixels", "clicks", "stats",
]);

const AD_URL_FRAGMENT_PATTERNS = [
  "/ads/",
  "/ad/",
  "/advert",
  "adserver",
  "adframe",
  "adbrite",
  "adlink",
  "adsystem",
  "/banners/",
  "/banner_",
  "bannerid",
  "/sponsor",
  "sponsored",
  "/affiliate",
  "affiliate",
  "affid=",
  "utm_",
  "ref=",
  "tag=",
  "click_id",
  "clickid",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "/pixel",
  "pixel_id",
  "/tracker",
  "/tracking",
  "/analytics",
  "/telemetry",
  "trackingid",
];

const NON_HTTP_SCHEMES = [
  "mailto:",
  "tel:",
  "sms:",
  "javascript:",
  "data:",
  "blob:",
  "file:",
  "ftp:",
  "ws:",
  "wss:",
  "chrome:",
  "about:",
  "intent:",
  "whatsapp:",
  "magnet:",
];

/** Extensions that are binary/media downloads rather than pages. */
const NON_PAGE_EXTENSIONS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
  ".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".m4v",
  ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".msi", ".dmg", ".apk", ".deb", ".rpm", ".appimage",
  ".iso", ".bin", ".dmg", ".torrent",
  ".css", ".xml", ".rss", ".atom", ".json", ".woff", ".woff2", ".ttf", ".otf", ".eot",
];

/**
 * Cloud-infrastructure boilerplate that pages inject automatically (footers,
 * script tags, headers). These mention vendors like Cloudflare in CODE, not
 * in CONTENT, so they must never flag a URL. Matched case-insensitively and
 * removed before scanning.
 */
const VENDOR_NOISE_PATTERNS: RegExp[] = [
  /performance\s+(and|&)?\s*security\s+by\s+\S+/gi,
  /protected\s+by\s+\S+/gi,
  /ddos\s+protection\s+by\s+\S+/gi,
  /powered\s+by\s+\S*(?:cloud|cdn|edge)[^\s,.]{0,20}/gi,
  /ray\s+id\s*[:#]?\s*[0-9a-f]{6,}/gi,
  /\[?cloudflare\]?\s*\((?:https?:\/\/[^)]*cloudflare[^)]*)\)/gi,
  /https?:\/\/[^\s)\]]*cloudflare[a-z]*\.com[^\s)\]]*/gi,
  /https?:\/\/[^\s)\]]*cloudfront\.net[^\s)\]]*/gi,
  /https?:\/\/[^\s)\]]*cloudinary\.com[^\s)\]]*/gi,
  /https?:\/\/[^\s)\]]*res\.cloudinary[^\s)\]]*/gi,
  /\/cdn-cgi\//gi,
  /__cf[a-z_]{2,}/gi,
  /cf[-_]ray/gi,
  // Vendor product names on their own (Cloudflare, CloudFront, Cloudinary,
  // ...) — infrastructure mentions, never content mentions.
  /\b(?:cloudflare|cloudfront|cloudinary|cloudfoundry|cloudera|cloudways|cloudbeds)\b/gi,
];

/**
 * Removes vendor noise lines/phrases from markdown before the cloud scan.
 * Only strips the matched phrase itself (not the whole page), so genuine
 * content around it still scans normally.
 */
export function stripVendorNoise(text: string): string {
  let out = text || "";
  for (const re of VENDOR_NOISE_PATTERNS) {
    out = out.replace(re, " ");
  }
  return out;
}

/**
 * Cloud + related spellings, matched on the raw text (case-insensitive).
 * Prefix matching (no trailing word boundary) is intentional so stems like
 * "clouds", "cloudy", "clouded", "cloudberry" all hit:
 * the requirement is "any mention of a cloud" IN CONTENT — vendor boilerplate
 * is stripped first (see stripVendorNoise).
 */
const O_SET = "0o\u043e\u039f\u03bf"; // 0, o, cyrillic/greek homoglyphs
const L_SET = "l1|\u04c0\u0399\u03b9"; // l, 1, |, cyrillic/greek homoglyphs

const CLOUD_VARIANTS: Array<{ label: string; leet: RegExp }> = [
  { label: "cloud*", leet: new RegExp(`c\\s*[${L_SET}]\\s*[${O_SET}]\\s*[u\\u0443]\\s*d`) },
  { label: "kloud*", leet: new RegExp(`k\\s*[${L_SET}]\\s*[${O_SET}]\\s*[u\\u0443]\\s*d`) },
  { label: "cload*", leet: new RegExp(`c\\s*[${L_SET}]\\s*[${O_SET}]\\s*[a4@\\u0430]\\s*d`) },
];

/** Standalone "c loud" / "cl oud" / "c-l-o-u-d" style splits. */
const SPLIT_CLOUD = /(?:^|[^a-z0-9])c[\s._-]?l[\s._-]?[0o0][\s._-]?u[\s._-]?d(?:[^a-z0-9]|$)/i;

/**
 * Cheap superset prefilter: requires the full cloud letter shape
 * (c|k + l-homoglyph + o-homoglyph + u/a + d with small separator gaps).
 * Deliberately does NOT match ordinary words like "could", "clod" or
 * "clad", but anything it hits that the precise variants miss is still
 * reported as a conservative hit.
 */
const CLOUD_LOOSE = new RegExp(
  `(?:c|k)[\\s._-]{0,3}[${L_SET}][\\s._-]{0,3}[${O_SET}][\\s._-]{0,3}(?:u|\\u0443|a|4|@)[\\s._-]{0,3}d`,
  "i",
);

export interface CloudScanResult {
  cloudFound: boolean;
  matches: Array<{ variant: string; excerpt: string }>;
}

/**
 * Scans markdown/text for any cloud variant mention. Returns matched variant
 * labels plus a short excerpt around the first few hits for the response body.
 */
export function scanTextForCloud(rawText: string): CloudScanResult {
  const matches: CloudScanResult["matches"] = [];
  if (!rawText) return { cloudFound: false, matches };

  // Vendor infrastructure boilerplate ("Performance and Security by
  // Cloudflare", cloudfront URLs, ...) is code-injected noise, not content.
  const text = stripVendorNoise(rawText);
  if (!text.trim()) return { cloudFound: false, matches };

  const maxIdx = Math.min(text.length, 2_000_000);
  const haystack = text.slice(0, maxIdx);

  // Loose pre-filter: cheap reject for pages without any cloud-ish letters.
  const loose = haystack.match(CLOUD_LOOSE);
  if (!loose) {
    return { cloudFound: false, matches };
  }

  const pushMatch = (variant: string, index: number) => {
    if (matches.length >= 5) return;
    const start = Math.max(0, index - 40);
    const end = Math.min(haystack.length, index + 80);
    matches.push({
      variant,
      excerpt: haystack
        .slice(start, end)
        .replace(/\s+/g, " ")
        .trim(),
    });
  };

  // Per-variant leet/relaxed matching (word stems + common obfuscations).
  for (const v of CLOUD_VARIANTS) {
    const re = new RegExp(v.leet.source, v.leet.flags + "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
      pushMatch(v.label, m.index);
      if (matches.length >= 5) break;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (matches.length >= 5) break;
  }

  // Split spellings: "c loud", "cl.oud", "c-l-o-u-d"...
  if (matches.length < 5) {
    const m = SPLIT_CLOUD.exec(haystack);
    if (m) pushMatch("c-loud (split)", m.index);
  }

  if (matches.length === 0 && loose) {
    // Fallback for exotic obfuscation the variant list missed (e.g. cyrillic
    // homoglyphs already covered, but zero-width tricks are not): report the
    // loose hit itself so the caller still gets a signal.
    pushMatch("cloud-like", loose.index ?? 0);
  }

  return { cloudFound: matches.length > 0, matches };
}

export interface ClassifiedLink {
  url: string;
  text: string;
}

export interface LinkHarvest {
  candidates: ClassifiedLink[];
  skipped: { ad: number; binary: number; foreign: number; other: number };
}

function isAdLike(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  // Whole-host substrings (vendor domains) ...
  if (AD_HOST_PATTERNS.some((p) => host.includes(p))) return true;
  // ... and dedicated ad/track subdomain segments (ads.example.com etc.),
  // which must match a full label to avoid "load." style false positives.
  if (host.split(".").some((s) => AD_HOST_SEGMENTS.has(s))) return true;
  const full = url.toString().toLowerCase();
  if (AD_URL_FRAGMENT_PATTERNS.some((p) => full.includes(p))) return true;
  return false;
}

function isBinaryLike(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  if (NON_PAGE_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
  return false;
}

/**
 * Extracts followable links from the page HTML, drops ads/trackers/binary
 * links, and returns up to `maxLinks` deduped candidates plus skip counters.
 * Anchor text is captured so the caller can prefer content-looking links.
 */
export function harvestLinks(
  html: string,
  baseUrl: string,
  maxLinks: number = MAX_LINKS_PER_PAGE,
): LinkHarvest {
  const skipped = { ad: 0, binary: 0, foreign: 0, other: 0 };
  const seen = new Set<string>();
  const candidates: ClassifiedLink[] = [];

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { candidates, skipped };
  }

  // Cheap, dependency-free anchor extraction.
  const anchorRe = /<a\b([^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && candidates.length < maxLinks * 3) {
    const attrs = m[1] || "";
    const href = (m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (!href) continue;

    // Skip nofollow-marked links (ads, sponsored, untrusted by convention).
    if (/\brel\s*=\s*("[^"]*"|'[^']*')/i.test(attrs)) {
      const rel = (attrs.match(/\brel\s*=\s*("[^"]*"|'[^']*')/i)?.[1] || "").toLowerCase();
      if (rel.includes("nofollow") || rel.includes("sponsored") || rel.includes("ad")) {
        skipped.ad += 1;
        continue;
      }
    }

    const lower = href.toLowerCase();
    if (NON_HTTP_SCHEMES.some((s) => lower.startsWith(s))) {
      skipped.other += 1;
      continue;
    }

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      skipped.other += 1;
      continue;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      skipped.other += 1;
      continue;
    }

    // Strip fragment and normalize; drop self-links and duplicates.
    resolved.hash = "";
    const urlStr = resolved.toString();
    const key = urlStr.replace(/\/$/, "") || urlStr;
    const baseKey = base.toString().replace(/\/$/, "");
    if (key === baseKey) {
      skipped.other += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    if (isAdLike(resolved)) {
      skipped.ad += 1;
      continue;
    }
    if (isBinaryLike(resolved)) {
      skipped.binary += 1;
      continue;
    }

    const text = (m[6] || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    candidates.push({ url: urlStr, text: text.slice(0, 120) });
  }

  // Prefer links with descriptive text (content links over icon/nav links).
  candidates.sort((a, b) => (b.text ? b.text.length : 0) - (a.text ? a.text.length : 0));

  return { candidates: candidates.slice(0, maxLinks), skipped };
}
