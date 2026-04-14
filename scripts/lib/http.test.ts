import { describe, test, expect } from "bun:test";
import { detectProxy, buildHeaders, CONNECT_TIMEOUT, TOTAL_TIMEOUT, RETRY_DELAYS_HTTP, RETRYABLE_HTTP } from "./http";

describe("detectProxy", () => {
  test("returns null when no proxy env vars", () => {
    expect(detectProxy({})).toBeNull();
  });

  test("detects HTTPS_PROXY", () => {
    expect(detectProxy({ HTTPS_PROXY: "http://proxy:8080" })).toBe(
      "http://proxy:8080",
    );
  });

  test("detects HTTP_PROXY", () => {
    expect(detectProxy({ HTTP_PROXY: "http://proxy:8080" })).toBe(
      "http://proxy:8080",
    );
  });

  test("detects ALL_PROXY", () => {
    expect(detectProxy({ ALL_PROXY: "socks5://proxy:1080" })).toBe(
      "socks5://proxy:1080",
    );
  });

  test("HTTPS_PROXY takes priority", () => {
    expect(
      detectProxy({
        HTTPS_PROXY: "http://a:1",
        HTTP_PROXY: "http://b:2",
        ALL_PROXY: "http://c:3",
      }),
    ).toBe("http://a:1");
  });
});

describe("buildHeaders", () => {
  test("includes x-goog-api-key", () => {
    const headers = buildHeaders("test-key");
    expect(headers["x-goog-api-key"]).toBe("test-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("exported transport constants", () => {
  test("exports expected values", () => {
    expect(CONNECT_TIMEOUT).toBe(30_000);
    expect(TOTAL_TIMEOUT).toBe(300_000);
    expect(RETRY_DELAYS_HTTP).toEqual([1000, 2000, 4000]);
    expect(RETRYABLE_HTTP).toEqual(new Set([429, 500, 503]));
  });
});
