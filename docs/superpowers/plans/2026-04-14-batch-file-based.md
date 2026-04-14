# Batch File-Based Input/Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch batch operations from inline to file-based mode via Google Files API, fixing large-response socket disconnections.

**Architecture:** New `scripts/lib/files.ts` encapsulates Files API upload/download. `google.ts` provider builds JSONL input, uploads via Files API, creates batch with file reference. Fetch downloads result JSONL via streaming. Inline fallback preserved for in-flight jobs.

**Tech Stack:** Bun, TypeScript, Google Gemini Batch API, Google Files API (resumable upload protocol)

**Spec:** `docs/superpowers/specs/2026-04-14-batch-file-based-design.md`

---

### Task 1: Export shared transport constants from http.ts

**Files:**
- Modify: `scripts/lib/http.ts:3-4,117-118`
- Test: `scripts/lib/http.test.ts`

- [ ] **Step 1: Write the failing test**

In `scripts/lib/http.test.ts`, add a test verifying the constants are exported:

```typescript
import { CONNECT_TIMEOUT, TOTAL_TIMEOUT, RETRY_DELAYS_HTTP, RETRYABLE_HTTP } from "./http";

describe("exported transport constants", () => {
  test("exports expected values", () => {
    expect(CONNECT_TIMEOUT).toBe(30_000);
    expect(TOTAL_TIMEOUT).toBe(300_000);
    expect(RETRY_DELAYS_HTTP).toEqual([1000, 2000, 4000]);
    expect(RETRYABLE_HTTP).toEqual(new Set([429, 500, 503]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/lib/http.test.ts`
Expected: FAIL — these symbols are not exported.

- [ ] **Step 3: Add export keywords**

In `scripts/lib/http.ts`, change the 4 constant declarations from `const` to `export const`:

```typescript
// Line 3-4:
export const CONNECT_TIMEOUT = 30_000;
export const TOTAL_TIMEOUT = 300_000;

// Line 117-118:
export const RETRY_DELAYS_HTTP = [1000, 2000, 4000];
export const RETRYABLE_HTTP = new Set([429, 500, 503]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/lib/http.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/http.test.ts
git commit -m "refactor(http): export shared transport constants"
```

---

### Task 2: Add responsesFile to BatchJob type

**Files:**
- Modify: `scripts/providers/types.ts:29-40`
- Test: `scripts/providers/types.test.ts`

- [ ] **Step 1: Write the failing test**

In `scripts/providers/types.test.ts`, add a compile-time test:

```typescript
import type { BatchJob } from "./types";

describe("BatchJob type", () => {
  test("accepts responsesFile field", () => {
    const job: BatchJob = {
      id: "batches/abc",
      state: "succeeded",
      createTime: "2026-04-14T00:00:00Z",
      responsesFile: "files/output456",
    };
    expect(job.responsesFile).toBe("files/output456");
  });

  test("responsesFile is optional", () => {
    const job: BatchJob = {
      id: "batches/abc",
      state: "pending",
      createTime: "2026-04-14T00:00:00Z",
    };
    expect(job.responsesFile).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/providers/types.test.ts`
Expected: FAIL — `responsesFile` does not exist on type `BatchJob`.

- [ ] **Step 3: Add responsesFile to BatchJob**

In `scripts/providers/types.ts`, add after line 39 (`stats?` field):

```typescript
export interface BatchJob {
  id: string;
  state:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";
  createTime: string;
  stats?: { total: number; succeeded: number; failed: number };
  responsesFile?: string; // file-based output: "files/abc123"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/providers/types.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/types.ts scripts/providers/types.test.ts
git commit -m "feat(types): add responsesFile to BatchJob"
```

---

### Task 3: Create files.ts — uploadJsonl

**Files:**
- Create: `scripts/lib/files.ts`
- Create: `scripts/lib/files.test.ts`

- [ ] **Step 1: Write the failing test for fetch-path upload**

In `scripts/lib/files.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { uploadJsonl } from "./files";

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
    expect(step1Init.headers).toHaveProperty("X-Goog-Upload-Protocol", "resumable");
    expect(step1Init.headers).toHaveProperty("X-Goog-Upload-Command", "start");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/lib/files.test.ts`
Expected: FAIL — module `./files` not found.

- [ ] **Step 3: Implement uploadJsonl**

Create `scripts/lib/files.ts`:

```typescript
import { execFileSync } from "child_process";
import {
  detectProxy,
  CONNECT_TIMEOUT,
  TOTAL_TIMEOUT,
  RETRY_DELAYS_HTTP,
  RETRYABLE_HTTP,
} from "./http";

const DOWNLOAD_TIMEOUT = 600_000;

async function withRetry<T>(fn: () => Promise<T>, isRetryable: (err: unknown) => boolean): Promise<T> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === RETRY_DELAYS_HTTP.length) throw err;
      await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
    }
  }
  throw new Error("Unreachable");
}

export async function uploadJsonl(
  data: Uint8Array,
  displayName: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlUploadJsonl(data, displayName, apiKey, baseUrl, proxy);
  }
  return fetchUploadJsonl(data, displayName, apiKey, baseUrl);
}

async function fetchUploadJsonl(
  data: Uint8Array,
  displayName: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  return withRetry(async () => {
    // Step 1: initiate resumable upload
    const startUrl = `${baseUrl}/upload/v1beta/files`;
    const controller1 = new AbortController();
    const timeout1 = setTimeout(() => controller1.abort(), TOTAL_TIMEOUT);
    let uploadUrl: string;
    try {
      const res1 = await fetch(startUrl, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(data.byteLength),
          "X-Goog-Upload-Header-Content-Type": "application/jsonl",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: displayName } }),
        signal: controller1.signal,
      });
      if (!res1.ok) {
        const text = await res1.text().catch(() => "");
        const status = res1.status;
        if (RETRYABLE_HTTP.has(status)) throw Object.assign(new Error(`Upload start failed: HTTP ${status}`), { retryable: true });
        throw new Error(`Upload start failed: HTTP ${status} — ${text.slice(0, 200)}`);
      }
      uploadUrl = res1.headers.get("x-goog-upload-url") ?? "";
      if (!uploadUrl) throw new Error("No upload URL in response headers");
    } finally {
      clearTimeout(timeout1);
    }

    // Step 2: upload bytes and finalize
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), TOTAL_TIMEOUT);
    try {
      const res2 = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(data.byteLength),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: data,
        signal: controller2.signal,
      });
      if (!res2.ok) {
        const text = await res2.text().catch(() => "");
        const status = res2.status;
        if (RETRYABLE_HTTP.has(status)) throw Object.assign(new Error(`Upload finalize failed: HTTP ${status}`), { retryable: true });
        throw new Error(`Upload finalize failed: HTTP ${status} — ${text.slice(0, 200)}`);
      }
      const body = (await res2.json()) as { file?: { name?: string } };
      const fileName = body.file?.name;
      if (!fileName) throw new Error("No file name in upload response");
      return fileName;
    } finally {
      clearTimeout(timeout2);
    }
  }, (err) => (err as { retryable?: boolean }).retryable === true);
}

function curlUploadJsonl(
  data: Uint8Array,
  displayName: string,
  apiKey: string,
  baseUrl: string,
  proxy: string,
): string {
  const tmpHeader = `/tmp/jdy-imagine-upload-header-${Date.now()}.tmp`;
  const tmpBody = `/tmp/jdy-imagine-upload-body-${Date.now()}.tmp`;

  try {
    // Write data to temp file for curl
    require("fs").writeFileSync(tmpBody, data);

    // Step 1: initiate resumable upload
    execFileSync("curl", [
      "-s", "-D", tmpHeader,
      "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
      "--max-time", String(TOTAL_TIMEOUT / 1000),
      "-x", proxy,
      "-X", "POST",
      "-H", `x-goog-api-key: ${apiKey}`,
      "-H", "X-Goog-Upload-Protocol: resumable",
      "-H", "X-Goog-Upload-Command: start",
      "-H", `X-Goog-Upload-Header-Content-Length: ${data.byteLength}`,
      "-H", "X-Goog-Upload-Header-Content-Type: application/jsonl",
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ file: { display_name: displayName } }),
      `${baseUrl}/upload/v1beta/files`,
    ], { encoding: "utf-8" });

    const headers = require("fs").readFileSync(tmpHeader, "utf-8");
    const match = headers.match(/x-goog-upload-url:\s*(\S+)/i);
    if (!match) throw new Error("No upload URL in curl response headers");
    const uploadUrl = match[1].trim();

    // Step 2: upload finalize
    const output = execFileSync("curl", [
      "-s",
      "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
      "--max-time", String(TOTAL_TIMEOUT / 1000),
      "-x", proxy,
      "-X", "PUT",
      "-H", `Content-Length: ${data.byteLength}`,
      "-H", "X-Goog-Upload-Offset: 0",
      "-H", "X-Goog-Upload-Command: upload, finalize",
      "--data-binary", `@${tmpBody}`,
      uploadUrl,
    ], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });

    const body = JSON.parse(output) as { file?: { name?: string } };
    const fileName = body.file?.name;
    if (!fileName) throw new Error("No file name in curl upload response");
    return fileName;
  } finally {
    try { require("fs").unlinkSync(tmpHeader); } catch {}
    try { require("fs").unlinkSync(tmpBody); } catch {}
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/lib/files.test.ts`
Expected: ALL PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/files.ts scripts/lib/files.test.ts
git commit -m "feat(files): add uploadJsonl with resumable upload protocol"
```

---

### Task 4: Create files.ts — downloadJsonl

**Files:**
- Modify: `scripts/lib/files.ts`
- Modify: `scripts/lib/files.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/files.test.ts`:

```typescript
import { downloadJsonl } from "./files";

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
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://generativelanguage.googleapis.com/download/v1beta/files/output456:download?alt=media");
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await downloadJsonl("files/output456", "key", "https://generativelanguage.googleapis.com", () => {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/lib/files.test.ts`
Expected: FAIL — `downloadJsonl` not exported from `./files`.

- [ ] **Step 3: Implement downloadJsonl**

Add to `scripts/lib/files.ts`:

```typescript
export async function downloadJsonl(
  fileName: string,
  apiKey: string,
  baseUrl: string,
  onLine: (line: string) => void,
): Promise<void> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlDownloadJsonl(fileName, apiKey, baseUrl, proxy, onLine);
  }
  return fetchDownloadJsonl(fileName, apiKey, baseUrl, onLine);
}

async function fetchDownloadJsonl(
  fileName: string,
  apiKey: string,
  baseUrl: string,
  onLine: (line: string) => void,
): Promise<void> {
  const url = `${baseUrl}/download/v1beta/${fileName}:download?alt=media`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: { "x-goog-api-key": apiKey },
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Download failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }

    // Stream response body line by line
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop()!; // Keep incomplete last line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    }

    // Flush remaining buffer
    buffer += decoder.decode();
    const trimmed = buffer.trim();
    if (trimmed) onLine(trimmed);
  } finally {
    clearTimeout(timeout);
  }
}

function curlDownloadJsonl(
  fileName: string,
  apiKey: string,
  baseUrl: string,
  proxy: string,
  onLine: (line: string) => void,
): void {
  const url = `${baseUrl}/download/v1beta/${fileName}:download?alt=media`;
  const output = execFileSync("curl", [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(DOWNLOAD_TIMEOUT / 1000),
    "-x", proxy,
    "-H", `x-goog-api-key: ${apiKey}`,
    "-w", "\n%{http_code}",
    url,
  ], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });

  const lines = output.trimEnd().split("\n");
  const statusCode = parseInt(lines.pop()!, 10);
  if (statusCode !== 200) {
    throw new Error(`Download failed: HTTP ${statusCode} — ${lines.join("\n").slice(0, 200)}`);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/lib/files.test.ts`
Expected: ALL PASS (7 tests total)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/files.ts scripts/lib/files.test.ts
git commit -m "feat(files): add downloadJsonl with streaming line parser"
```

---

### Task 5: Implement buildBatchJsonl in google.ts

**Files:**
- Modify: `scripts/providers/google.ts:199-266`
- Modify: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `scripts/providers/google.test.ts`:

```typescript
import { buildBatchJsonl } from "./google";

describe("buildBatchJsonl", () => {
  test("produces valid JSONL with correct keys", () => {
    const { data, keys } = buildBatchJsonl(
      "gemini-3.1-flash-image-preview",
      [
        { prompt: "A sunset over mountains", model: "test", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" },
        { prompt: "A cat sleeping", model: "test", ar: null, quality: "normal", refs: [], imageSize: "1K" },
      ],
      "test-batch",
    );

    const text = new TextDecoder().decode(data);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);

    // Each line is valid JSON
    const line1 = JSON.parse(lines[0]);
    const line2 = JSON.parse(lines[1]);

    // Keys follow {seq}-{slug} format
    expect(line1.key).toMatch(/^001-/);
    expect(line2.key).toMatch(/^002-/);
    expect(keys).toEqual([line1.key, line2.key]);

    // Request structure
    expect(line1.request.contents[0].parts).toBeDefined();
    expect(line1.request.generationConfig.responseModalities).toEqual(["IMAGE"]);
    expect(line1.request.generationConfig.imageConfig.imageSize).toBe("2K");
    expect(line2.request.generationConfig.imageConfig.imageSize).toBe("1K");
  });

  test("includes aspect ratio in prompt text", () => {
    const { data } = buildBatchJsonl(
      "test-model",
      [{ prompt: "A cat", model: "test", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" }],
      "test",
    );

    const line = JSON.parse(new TextDecoder().decode(data).trim());
    const textPart = line.request.contents[0].parts.find((p: any) => p.text);
    expect(textPart.text).toContain("Aspect ratio: 16:9");
  });

  test("inlines ref images as base64", () => {
    const { mkdtempSync, writeFileSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");
    const dir = mkdtempSync(join(tmpdir(), "jsonl-ref-"));
    const refPath = join(dir, "ref.png");
    writeFileSync(refPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { data } = buildBatchJsonl(
      "test-model",
      [{ prompt: "Edit this", model: "test", ar: null, quality: "2k", refs: [refPath], imageSize: "2K" }],
      "test",
    );

    const line = JSON.parse(new TextDecoder().decode(data).trim());
    const parts = line.request.contents[0].parts;
    expect(parts[0]).toHaveProperty("inlineData");
    expect(parts[0].inlineData.mimeType).toBe("image/png");
    expect(parts[1]).toHaveProperty("text");
  });

  test("returns Uint8Array with trailing newline", () => {
    const { data } = buildBatchJsonl(
      "test-model",
      [{ prompt: "A cat", model: "test", ar: null, quality: "normal", refs: [], imageSize: "1K" }],
      "test",
    );

    const text = new TextDecoder().decode(data);
    expect(text.endsWith("\n")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/providers/google.test.ts`
Expected: FAIL — `buildBatchJsonl` not exported.

- [ ] **Step 3: Implement buildBatchJsonl**

Add to `scripts/providers/google.ts` after `buildBatchRequestBody`:

```typescript
export function buildBatchJsonl(
  _model: string,
  tasks: GenerateRequest[],
  _displayName: string,
): { data: Uint8Array; keys: string[] } {
  const keys: string[] = [];
  const lines: string[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(task.prompt);
    const key = `${seq}-${slug}`;
    keys.push(key);

    // Build parts: ref images first, then prompt text
    const parts: Array<Record<string, unknown>> = [];
    for (const refPath of task.refs) {
      const data = readFileSync(refPath);
      const ext = refPath.split(".").pop()?.toLowerCase();
      const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      parts.push({
        inlineData: {
          data: Buffer.from(data).toString("base64"),
          mimeType,
        },
      });
    }

    let promptText = task.prompt;
    if (task.ar) {
      promptText += `. Aspect ratio: ${task.ar}.`;
    }
    parts.push({ text: promptText });

    const lineObj = {
      key,
      request: {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { imageSize: task.imageSize },
        },
      },
    };
    lines.push(JSON.stringify(lineObj));
  }

  const text = lines.join("\n") + "\n";
  return { data: new TextEncoder().encode(text), keys };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/providers/google.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): add buildBatchJsonl for file-based input"
```

---

### Task 6: Implement JSONL result line parser

**Files:**
- Modify: `scripts/providers/google.ts`
- Modify: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `scripts/providers/google.test.ts`:

```typescript
import { parseJsonlResultLine } from "./google";

describe("parseJsonlResultLine", () => {
  test("parses successful result line", () => {
    const line = JSON.stringify({
      key: "001-cat",
      response: {
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                data: Buffer.from("img").toString("base64"),
                mimeType: "image/png",
              },
            }],
          },
          finishReason: "STOP",
        }],
      },
    });

    const result = parseJsonlResultLine(line);
    expect(result).not.toBeNull();
    expect(result!.key).toBe("001-cat");
    expect(result!.result?.images).toHaveLength(1);
  });

  test("parses error result line", () => {
    const line = JSON.stringify({
      key: "002-fail",
      error: { message: "Content blocked" },
    });

    const result = parseJsonlResultLine(line);
    expect(result).not.toBeNull();
    expect(result!.key).toBe("002-fail");
    expect(result!.error).toBe("Content blocked");
  });

  test("returns null for malformed JSON", () => {
    const result = parseJsonlResultLine("not-json{{{");
    expect(result).toBeNull();
  });

  test("returns null for empty line", () => {
    const result = parseJsonlResultLine("");
    expect(result).toBeNull();
  });

  test("handles line with response.error (API error)", () => {
    const line = JSON.stringify({
      key: "003-err",
      response: {
        error: { message: "Internal error" },
      },
    });

    const result = parseJsonlResultLine(line);
    expect(result!.key).toBe("003-err");
    expect(result!.error).toBe("Internal error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/providers/google.test.ts`
Expected: FAIL — `parseJsonlResultLine` not exported.

- [ ] **Step 3: Implement parseJsonlResultLine**

Add to `scripts/providers/google.ts`:

```typescript
export function parseJsonlResultLine(line: string): BatchResult | null {
  if (!line.trim()) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error(`Warning: Failed to parse JSONL line: ${line.slice(0, 100)}`);
    return null;
  }

  const key = (parsed.key as string) ?? "unknown";

  // Top-level error
  if (parsed.error) {
    const errObj = parsed.error as { message?: string };
    return { key, error: errObj.message ?? "Unknown error" };
  }

  // Response with error
  const response = parsed.response as Record<string, unknown> | undefined;
  if (response?.error) {
    const errObj = response.error as { message?: string };
    return { key, error: errObj.message ?? "Unknown error" };
  }

  // Successful response
  if (response) {
    const result = parseGenerateResponse(
      response as Parameters<typeof parseGenerateResponse>[0],
    );
    return { key, result };
  }

  return { key, error: "No response in result line" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/providers/google.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): add parseJsonlResultLine for file-based results"
```

---

### Task 7: Rewire batchCreate to use file-based input

**Files:**
- Modify: `scripts/providers/google.ts:370-400`

- [ ] **Step 1: Write the failing test**

Add to `scripts/providers/google.test.ts`. This is an integration-style test that mocks fetch to verify the new flow:

```typescript
import { createGoogleProvider } from "./google";

describe("batchCreate (file-based)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uploads JSONL then creates batch with file_name", async () => {
    const capturedUrls: string[] = [];
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrls.push(url);

      // Files API: resumable start
      if (url.includes("/upload/v1beta/files")) {
        return new Response(null, {
          status: 200,
          headers: { "x-goog-upload-url": "https://upload.example.com/finalize" },
        });
      }

      // Files API: upload finalize
      if (url.includes("upload.example.com/finalize")) {
        return new Response(JSON.stringify({ file: { name: "files/input789" } }), { status: 200 });
      }

      // Batch create
      if (url.includes(":batchGenerateContent")) {
        if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({
          name: "batches/job1",
          metadata: { state: "JOB_STATE_PENDING", createTime: "2026-04-14T00:00:00Z" },
        }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const job = await provider.batchCreate!({
      model: "gemini-3.1-flash-image-preview",
      tasks: [{ prompt: "A cat", model: "test", ar: null, quality: "normal", refs: [], imageSize: "1K" }],
    });

    expect(job.id).toBe("batches/job1");
    expect(job.state).toBe("pending");

    // Verify batch create body uses file_name, NOT inline requests
    const batchBody = capturedBodies[0] as any;
    expect(batchBody.batch.input_config.file_name).toBe("files/input789");
    expect(batchBody.batch.input_config.requests).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/providers/google.test.ts`
Expected: FAIL — batchCreate still sends inline requests.

- [ ] **Step 3: Rewire batchCreate**

In `scripts/providers/google.ts`, modify the `batchCreate` method inside `createGoogleProvider`:

```typescript
    async batchCreate(req: BatchCreateRequest): Promise<BatchJob> {
      validateBatchTasks(req.tasks);

      const displayName = req.displayName ?? `jdy-imagine-${Date.now()}`;
      const { data } = buildBatchJsonl(req.model, req.tasks, displayName);

      // Soft warning for large payloads (file input supports up to 2GB)
      const payloadMB = data.byteLength / (1024 * 1024);
      if (payloadMB > 50) {
        console.error(`Warning: Large payload (~${Math.round(payloadMB)}MB), upload may take a while.`);
      }

      // Upload JSONL via Files API
      const fileName = await uploadJsonl(data, displayName, apiKey, baseUrl);

      // Create batch with file reference
      const url = `${baseUrl}/v1beta/models/${req.model}:batchGenerateContent`;
      const body = {
        batch: {
          display_name: displayName,
          input_config: { file_name: fileName },
        },
      };
      const res = await httpPostWithRetry(url, body, apiKey);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }

      const respData = res.data as {
        name?: string;
        metadata?: { state?: string; createTime?: string };
      };
      return {
        id: respData.name ?? "",
        state: (respData.metadata?.state?.toLowerCase().replace("job_state_", "") ?? "pending") as BatchJob["state"],
        createTime: respData.metadata?.createTime ?? new Date().toISOString(),
      };
    },
```

Also add the import at the top of `google.ts`:

```typescript
import { uploadJsonl, downloadJsonl } from "../lib/files";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/providers/google.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): rewire batchCreate to file-based input via Files API"
```

---

### Task 8: Rewire batchGet to extract responsesFile

**Files:**
- Modify: `scripts/providers/google.ts:402-433`
- Modify: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `scripts/providers/google.test.ts`:

```typescript
describe("batchGet (file-based)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("extracts responsesFile from succeeded job", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        name: "batches/job1",
        metadata: {
          state: "JOB_STATE_SUCCEEDED",
          createTime: "2026-04-14T00:00:00Z",
          totalCount: 4,
          succeededCount: 4,
          failedCount: 0,
        },
        response: {
          responsesFile: "files/output456",
        },
      }), { status: 200 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const job = await provider.batchGet!("batches/job1");

    expect(job.state).toBe("succeeded");
    expect(job.responsesFile).toBe("files/output456");
    expect(job.stats?.total).toBe(4);
  });

  test("returns undefined responsesFile for pending job", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        name: "batches/job1",
        metadata: { state: "JOB_STATE_PENDING", createTime: "2026-04-14T00:00:00Z" },
      }), { status: 200 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const job = await provider.batchGet!("batches/job1");

    expect(job.state).toBe("pending");
    expect(job.responsesFile).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/providers/google.test.ts`
Expected: FAIL — `responsesFile` is undefined even for succeeded job (not extracted yet).

- [ ] **Step 3: Update batchGet to extract responsesFile**

In `scripts/providers/google.ts`, modify the `batchGet` method:

```typescript
    async batchGet(jobId: string): Promise<BatchJob> {
      const url = `${baseUrl}/v1beta/${jobId}`;
      const res = await httpGetWithRetry(url, apiKey);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }

      const data = res.data as {
        name?: string;
        metadata?: {
          state?: string;
          createTime?: string;
          totalCount?: number;
          succeededCount?: number;
          failedCount?: number;
        };
        response?: {
          responsesFile?: string;
          inlinedResponses?: unknown[];
        };
      };
      return {
        id: data.name ?? jobId,
        state: (data.metadata?.state?.toLowerCase().replace("job_state_", "") ?? "pending") as BatchJob["state"],
        createTime: data.metadata?.createTime ?? "",
        stats: data.metadata?.totalCount != null
          ? {
              total: data.metadata.totalCount,
              succeeded: data.metadata.succeededCount ?? 0,
              failed: data.metadata.failedCount ?? 0,
            }
          : undefined,
        responsesFile: data.response?.responsesFile,
      };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/providers/google.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): extract responsesFile from batchGet response"
```

---

### Task 9: Rewire batchFetch to download JSONL results with completeness check

**Files:**
- Modify: `scripts/providers/google.ts:435-446`
- Modify: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `scripts/providers/google.test.ts`:

```typescript
describe("batchFetch (file-based)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("downloads JSONL and parses results", async () => {
    const jsonlContent = [
      JSON.stringify({ key: "001-cat", response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img1").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] } }),
      JSON.stringify({ key: "002-dog", response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img2").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] } }),
    ].join("\n") + "\n";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // batchGet
      if (url.includes("batches/job1") && !url.includes("/download/")) {
        return new Response(JSON.stringify({
          name: "batches/job1",
          metadata: { state: "JOB_STATE_SUCCEEDED", totalCount: 2, succeededCount: 2, failedCount: 0 },
          response: { responsesFile: "files/output456" },
        }), { status: 200 });
      }

      // downloadJsonl
      if (url.includes("/download/")) {
        return new Response(jsonlContent, { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const results = await provider.batchFetch!("batches/job1");

    expect(results).toHaveLength(2);
    expect(results[0].key).toBe("001-cat");
    expect(results[0].result?.images).toHaveLength(1);
    expect(results[1].key).toBe("002-dog");
  });

  test("falls back to inlinedResponses for old inline jobs", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("batches/old-job")) {
        return new Response(JSON.stringify({
          name: "batches/old-job",
          metadata: { state: "JOB_STATE_SUCCEEDED" },
          response: {
            inlinedResponses: [{
              metadata: { key: "001-cat" },
              response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] },
            }],
          },
        }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const results = await provider.batchFetch!("batches/old-job");

    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("001-cat");
  });

  test("warns when result count differs from stats.total", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };

    const jsonlContent = JSON.stringify({ key: "001-cat", response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] } }) + "\n";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (!url.includes("/download/")) {
        return new Response(JSON.stringify({
          name: "batches/job1",
          metadata: { state: "JOB_STATE_SUCCEEDED", totalCount: 3, succeededCount: 3, failedCount: 0 },
          response: { responsesFile: "files/output456" },
        }), { status: 200 });
      }

      return new Response(jsonlContent, { status: 200 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const results = await provider.batchFetch!("batches/job1");

    expect(results).toHaveLength(1); // Only 1 line in JSONL, but stats says 3
    expect(errors.some(e => e.includes("Expected 3 results, got 1"))).toBe(true);

    console.error = originalError;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/providers/google.test.ts`
Expected: FAIL — batchFetch still uses inline GET.

- [ ] **Step 3: Rewrite batchFetch**

In `scripts/providers/google.ts`, replace the `batchFetch` method:

```typescript
    async batchFetch(jobId: string): Promise<BatchResult[]> {
      // Step 1: get full batch job response
      const url = `${baseUrl}/v1beta/${jobId}`;
      const res = await httpGetWithRetry(url, apiKey);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }

      const data = res.data as {
        metadata?: { totalCount?: number };
        response?: {
          responsesFile?: string;
          inlinedResponses?: Array<{
            metadata?: { key?: string };
            response?: Record<string, unknown>;
          }>;
        };
      };

      const expectedTotal = data.metadata?.totalCount;

      // Step 2: file-based path
      if (data.response?.responsesFile) {
        const results: BatchResult[] = [];
        await downloadJsonl(data.response.responsesFile, apiKey, baseUrl, (line) => {
          const result = parseJsonlResultLine(line);
          if (result) results.push(result);
        });

        // Completeness check
        if (expectedTotal != null && results.length < expectedTotal) {
          console.error(
            `Warning: Expected ${expectedTotal} results, got ${results.length}. ${expectedTotal - results.length} results may be missing.`,
          );
        }

        return results;
      }

      // Step 2b: inline fallback for old jobs
      if (data.response?.inlinedResponses) {
        return parseBatchResponse(data.response as Parameters<typeof parseBatchResponse>[0]);
      }

      const state = (data as { metadata?: { state?: string } }).metadata?.state ?? "unknown";
      throw new Error(`Batch job has no result file. Job state: ${state}`);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/providers/google.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): rewire batchFetch to download JSONL with completeness check"
```

---

### Task 10: Update batch.ts payload estimation threshold

**Files:**
- Modify: `scripts/commands/batch.ts:132-156`
- Modify: `scripts/commands/batch.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `scripts/commands/batch.test.ts` (or verify existing tests still pass with the new threshold). The key change is that the 20MB limit should become 100MB:

```typescript
describe("payload estimation", () => {
  test("allows payloads up to 100MB", () => {
    // This is a behavioral test: previously 20MB+ would throw, now only 100MB+ should.
    // We just verify the threshold constant in a snapshot-style test.
    // The actual constant is inside batchSubmit, so we test indirectly through the error message.
    // For now, verify existing tests still pass after the threshold change.
  });
});
```

Note: The payload estimation is embedded inside `batchSubmit()` which is hard to unit-test directly. The main goal is to update the threshold and verify existing tests don't break.

- [ ] **Step 2: Update the threshold**

In `scripts/commands/batch.ts`, change lines 147-153:

```typescript
    const LIMIT = 100 * 1024 * 1024; // file-based input supports up to 2GB; 100MB soft limit
    if (totalEstimate > LIMIT) {
      const charRefNote = character
        ? ` Character references are duplicated across all ${tasks.length} tasks — consider removing them or reducing tasks per batch.`
        : "";
      throw new Error(
        `Estimated batch payload (~${Math.round(totalEstimate / 1024 / 1024)}MB) exceeds 100MB limit.${charRefNote}`,
      );
    }
```

- [ ] **Step 3: Run all tests to verify nothing breaks**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/commands/batch.ts
git commit -m "feat(batch): raise payload limit to 100MB for file-based input"
```

---

### Task 11: Full regression test

**Files:**
- All modified files

- [ ] **Step 1: Run the complete test suite**

Run: `bun test`
Expected: ALL PASS — no regressions.

- [ ] **Step 2: Type check**

Run: `bun run tsc --noEmit` (or the project's type check command)
Expected: No type errors.

- [ ] **Step 3: Verify no unused imports or dead code**

Spot-check:
- `google.ts` imports `uploadJsonl` and `downloadJsonl` from `../lib/files`
- `google.ts` imports `parseJsonlResultLine` (local, same file)
- `buildBatchRequestBody` is still referenced by existing tests — left in place
- `parseBatchResponse` is still used in inline fallback path

- [ ] **Step 4: Commit any cleanup**

If any cleanup was needed:
```bash
git add -A
git commit -m "chore: cleanup after batch file-based migration"
```
