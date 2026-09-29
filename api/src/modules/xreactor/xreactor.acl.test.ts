import { afterEach, describe, expect, it } from "vitest";
import {
  XREACTOR_EDGE_HEADER,
  edgeTokenOk,
  hostIsXReactor,
  hostOf,
  isXReactorPath,
  xreactorAllowedHost,
} from "./xreactor.acl.js";

describe("xreactor host isolation", () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("defaults to the xreactor-bot.duckdns.org host", () => {
    delete process.env.XREACTOR_ALLOWED_HOST;
    expect(xreactorAllowedHost()).toBe("xreactor-bot.duckdns.org");
  });

  it("matches the configured host case-insensitively, ignoring port", () => {
    process.env.XREACTOR_ALLOWED_HOST = "xreactor-bot.duckdns.org";
    expect(hostIsXReactor("XREACTOR-BOT.DUCKDNS.ORG")).toBe(true);
    expect(hostIsXReactor("xreactor-bot.duckdns.org:80")).toBe(true);
    expect(hostIsXReactor("xreactor-bot.duckdns.org:443")).toBe(true);
    expect(hostIsXReactor("207.180.29.28:3000")).toBe(false);
    expect(hostIsXReactor("evil.com")).toBe(false);
  });

  it("takes the first host from proxy chains", () => {
    expect(hostOf("xreactor-bot.duckdns.org, 10.0.0.1")).toBe(
      "xreactor-bot.duckdns.org",
    );
  });

  it("rejects empty hosts", () => {
    expect(hostIsXReactor(undefined)).toBe(false);
    expect(hostIsXReactor("")).toBe(false);
  });
});

describe("xreactor path check", () => {
  it("recognizes /xreactor and subpaths, nothing else", () => {
    expect(isXReactorPath("/xreactor")).toBe(true);
    expect(isXReactorPath("/xreactor?url=https://example.com")).toBe(true);
    expect(isXReactorPath("/xreactorfoo")).toBe(false);
    expect(isXReactorPath("/v1/health")).toBe(false);
    expect(isXReactorPath("/ui/")).toBe(false);
  });
});

describe("xreactor edge token", () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("is a no-op when no token is configured", () => {
    delete process.env.XREACTOR_EDGE_TOKEN;
    expect(edgeTokenOk(undefined)).toBe(true);
    expect(edgeTokenOk("anything")).toBe(true);
  });

  it("requires a matching header when configured", () => {
    process.env.XREACTOR_EDGE_TOKEN = "s3cret";
    expect(edgeTokenOk(undefined)).toBe(false);
    expect(edgeTokenOk("wrong")).toBe(false);
    expect(edgeTokenOk("s3cret")).toBe(true);
  });

  it("exports the canonical header name", () => {
    expect(XREACTOR_EDGE_HEADER).toBe("x-xreactor-edge");
  });
});
