import { describe, expect, it } from "vitest";
import { hasRealContent, isPageSettled } from "./content-ready.js";

function snap(overrides: Partial<Parameters<typeof hasRealContent>[0]> = {}) {
  return {
    challenge: false,
    title: "Example Domain",
    contentChars: 500,
    tagCount: 30,
    pendingImages: 0,
    url: "https://example.com/",
    readyState: "complete",
    ...overrides,
  };
}

describe("hasRealContent", () => {
  it("accepts a normal loaded page", () => {
    expect(hasRealContent(snap())).toBe(true);
  });

  it("accepts a tiny real page (example.com) via tag count", () => {
    expect(hasRealContent(snap({ contentChars: 60, tagCount: 8 }))).toBe(true);
  });

  it("rejects an empty page", () => {
    expect(hasRealContent(snap({ contentChars: 0, tagCount: 0 }))).toBe(false);
  });

  it("rejects a challenge page regardless of thresholds", () => {
    expect(hasRealContent(snap({ challenge: true }))).toBe(false);
  });

  it("rejects a page still loading", () => {
    expect(hasRealContent(snap({ readyState: "loading" }))).toBe(false);
  });
});

describe("isPageSettled", () => {
  it("requires complete readyState", () => {
    expect(isPageSettled(snap())).toBe(true);
    expect(isPageSettled(snap({ readyState: "interactive" }))).toBe(false);
  });

  it("requires real content", () => {
    expect(isPageSettled(snap({ contentChars: 0, tagCount: 0 }))).toBe(false);
  });
});
