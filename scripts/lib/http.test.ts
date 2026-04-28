import { describe, test, expect, mock } from "bun:test";
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

describe("httpGetText", () => {
  test("returns raw text body, no JSON parsing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response('{"not":"json"}\n{"line":2}', { status: 200 }),
    ) as any;
    try {
      const { httpGetText } = await import("./http");
      const res = await httpGetText("https://x.test/file.jsonl", { Authorization: "Bearer k" });
      expect(res.status).toBe(200);
      expect(res.text).toBe('{"not":"json"}\n{"line":2}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns 503 on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => { throw new Error("ECONNREFUSED"); }) as any;
    try {
      const { httpGetText } = await import("./http");
      const res = await httpGetText("https://x.test/file", { Authorization: "Bearer k" });
      expect(res.status).toBe(503);
      expect(res.text).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("httpPostMultipart", () => {
  test("posts FormData with custom headers and auto Content-Type", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(async (input: any, init: any) => {
      const req = new Request(input, init);
      capturedHeaders = req.headers;
      return new Response(JSON.stringify({ id: "file_abc" }), { status: 200 });
    }) as any;
    try {
      const { httpPostMultipart } = await import("./http");
      const fd = new FormData();
      fd.append("purpose", "batch");
      fd.append("file", new Blob(["hello"]), "test.jsonl");
      const res = await httpPostMultipart("https://x.test/files", fd, { Authorization: "Bearer k" });
      expect(res.status).toBe(200);
      expect((res.data as any).id).toBe("file_abc");
      expect(capturedHeaders!.get("Authorization")).toBe("Bearer k");
      expect(capturedHeaders!.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns 503 on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => { throw new Error("ECONNREFUSED"); }) as any;
    try {
      const { httpPostMultipart } = await import("./http");
      const fd = new FormData();
      const res = await httpPostMultipart("https://x.test/files", fd, {});
      expect(res.status).toBe(503);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
