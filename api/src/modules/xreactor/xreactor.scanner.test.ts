import { describe, expect, it } from "vitest";
import {
  harvestLinks,
  scanTextForCloud,
  MAX_EXTRA_PAGES,
} from "./xreactor.scanner.js";

describe("scanTextForCloud", () => {
  it("returns clean for text without cloud mentions", () => {
    expect(scanTextForCloud("Welcome to the forum. Post your tools here.").cloudFound).toBe(false);
    expect(scanTextForCloud("The clod of dirt and the klaxon were loud.").cloudFound).toBe(false);
    expect(scanTextForCloud("could you help me").cloudFound).toBe(false);
  });

  it("detects plain cloud", () => {
    const r = scanTextForCloud("Upload your files to the cloud today.");
    expect(r.cloudFound).toBe(true);
    expect(r.matches[0].variant).toBe("cloud*");
  });

  it("detects word stems: clouds, cloudy, cloudflare", () => {
    expect(scanTextForCloud("It is cloudy outside.").cloudFound).toBe(true);
    expect(scanTextForCloud("Protected by Cloudflare").cloudFound).toBe(true);
    expect(scanTextForCloud("All the clouds gathered.").cloudFound).toBe(true);
  });

  it("detects leetspeak and spaced variants", () => {
    expect(scanTextForCloud("join my c1oud storage").cloudFound).toBe(true);
    expect(scanTextForCloud("join my cl0ud storage").cloudFound).toBe(true);
    expect(scanTextForCloud("KLOUD hosting is great").cloudFound).toBe(true);
    expect(scanTextForCloud("that c l o u d thing").cloudFound).toBe(true);
    expect(scanTextForCloud("c-l-o-u-d").cloudFound).toBe(true);
  });

  it("handles empty input", () => {
    expect(scanTextForCloud("").cloudFound).toBe(false);
  });
});

describe("harvestLinks", () => {
  const base = "https://example.com/thread/1";

  it("resolves relative links against the base and drops self-links", () => {
    const html = `
      <a href="/thread/2">Next thread</a>
      <a href="https://example.com/thread/1">self</a>
      <a href="#top">fragment</a>
    `;
    const r = harvestLinks(html, base);
    expect(r.candidates.map((c) => c.url)).toEqual(["https://example.com/thread/2"]);
  });

  it("filters ad and tracking hosts", () => {
    const html = `
      <a href="https://www.google-analytics.com/collect">analytics</a>
      <a href="https://ads.example.com/banner">ad server</a>
      <a href="https://example.com/thread/3?utm_source=news">tracked internal</a>
      <a href="https://example.com/thread/4">clean</a>
    `;
    const r = harvestLinks(html, base);
    expect(r.candidates.map((c) => c.url)).toEqual(["https://example.com/thread/4"]);
    expect(r.skipped.ad).toBeGreaterThanOrEqual(3);
  });

  it("filters non-http schemes and binary downloads", () => {
    const html = `
      <a href="mailto:someone@example.com">mail</a>
      <a href="javascript:void(0)">js</a>
      <a href="https://example.com/files/setup.exe">exe</a>
      <a href="https://example.com/docs/report.pdf">pdf</a>
      <a href="https://example.com/thread/5">clean</a>
    `;
    const r = harvestLinks(html, base);
    expect(r.candidates.map((c) => c.url)).toEqual(["https://example.com/thread/5"]);
    expect(r.skipped.binary).toBe(2);
  });

  it("skips nofollow/sponsored links as ads", () => {
    const html = `
      <a href="https://example.com/sponsor" rel="nofollow sponsored">sponsor</a>
      <a href="https://example.com/thread/6">clean</a>
    `;
    const r = harvestLinks(html, base);
    expect(r.candidates.map((c) => c.url)).toEqual(["https://example.com/thread/6"]);
    expect(r.skipped.ad).toBe(1);
  });

  it("dedupes links and caps at maxLinks", () => {
    const html = Array.from({ length: 20 }, (_, i) => `<a href="/page/${i}">link ${i} with text</a>`).join("\n");
    const r = harvestLinks(html, base, 5);
    expect(r.candidates.length).toBe(5);
  });

  it("exposes the extra-page cap constant", () => {
    expect(MAX_EXTRA_PAGES).toBe(3);
  });
});
