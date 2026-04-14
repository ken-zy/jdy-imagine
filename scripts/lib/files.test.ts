import { describe, test, expect, mock, afterEach } from "bun:test";
import { uploadJsonl, downloadJsonl } from "./files";

describe("uploadJsonl", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("performs resumable upload and returns file name", async () => {
    const uploadUrl = "https://upload.example.com/upload?id=123";

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // Step 1: resumable start
      if (url.includes("/upload/v1beta/files") && init?.method === "POST") {
        return new Response(null, {
          status: 200,
          headers: { "x-goog-upload-url": uploadUrl },
        });
      }

      // Step 2: upload finalize
      if (url === uploadUrl) {
        return new Response(
          JSON.stringify({ file: { name: "files/abc123", uri: "https://example.com/files/abc123" } }),
          { status: 200 },
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const data = new TextEncoder().encode('{"key":"001","request":{}}\n');
    const result = await uploadJsonl(data, "test-batch", "fake-key", "https://generativelanguage.googleapis.com");

    expect(result).toBe("files/abc123");

    // Verify Step 1 headers
    const calls = (globalThis.fetch as ReturnType<typeof mock>).mock.calls;
    const step1Init = calls[0][1] as RequestInit;
    const headers = step1Init.headers as Record<string, string>;
    expect(headers["X-Goog-Upload-Protocol"]).toBe("resumable");
    expect(headers["X-Goog-Upload-Command"]).toBe("start");
  });

  test("throws on Step 1 failure", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 });
    }) as typeof fetch;

    const data = new TextEncoder().encode("test\n");
    await expect(uploadJsonl(data, "test", "bad-key", "https://example.com")).rejects.toThrow();
  });

  test("throws when upload URL missing from headers", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(null, { status: 200 }); // No x-goog-upload-url header
    }) as typeof fetch;

    const data = new TextEncoder().encode("test\n");
    await expect(uploadJsonl(data, "test", "key", "https://example.com")).rejects.toThrow("upload URL");
  });
});

describe("downloadJsonl", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("streams JSONL lines via onLine callback", async () => {
    const jsonlContent = '{"key":"001","response":{"candidates":[]}}\n{"key":"002","response":{"candidates":[]}}\n';

    globalThis.fetch = mock(async () => {
      return new Response(jsonlContent, { status: 200 });
    }) as typeof fetch;

    const lines: string[] = [];
    await downloadJsonl("files/output456", "fake-key", "https://generativelanguage.googleapis.com", (line) => {
      lines.push(line);
    });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).key).toBe("001");
    expect(JSON.parse(lines[1]).key).toBe("002");
  });

  test("skips empty lines in JSONL", async () => {
    const jsonlContent = '{"key":"001"}\n\n{"key":"002"}\n';

    globalThis.fetch = mock(async () => {
      return new Response(jsonlContent, { status: 200 });
    }) as typeof fetch;

    const lines: string[] = [];
    await downloadJsonl("files/out", "key", "https://example.com", (line) => {
      lines.push(line);
    });

    expect(lines).toHaveLength(2);
  });

  test("throws on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    await expect(
      downloadJsonl("files/bad", "key", "https://example.com", () => {}),
    ).rejects.toThrow("404");
  });

  test("constructs correct download URL with alt=media", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await downloadJsonl("files/output456", "key", "https://generativelanguage.googleapis.com", () => {});
    expect(capturedUrl).toBe("https://generativelanguage.googleapis.com/download/v1beta/files/output456:download?alt=media");
  });
});
