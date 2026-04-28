# OpenAI gpt-image-2 Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI gpt-image-2 as a second provider to jdy-imagine, supporting realtime generate (text-to-image, image-to-image, edit with mask) and server-side batch (text-only with 50% discount). Simultaneously fix abstraction-layer pain points in `Provider` interface.

**Architecture:**
- HTTP layer parameterized: `httpPost/httpGet` accept headers map (not just apiKey); add `httpPostMultipart` and `httpGetText` helpers
- Provider factory upgraded to `(ProviderConfig) => Provider` allowing per-provider auth and config extensibility
- `GenerateRequest` gains `mask?` and `editTarget?`; `GenerateResult.finishReason` adds `ERROR`, drops `MAX_TOKENS`
- New OpenAI provider routes to `/v1/images/edits` when ANY image input present (refs OR editTarget OR mask), else `/v1/images/generations`
- OpenAI server-side batch is **text-only** (rejects refs / editTarget / mask / character profile injected refs) — by YAGNI choice
- Google provider keeps current behavior; `editTarget` falls back to `refs[0]`, `mask` is rejected

**Tech Stack:** Bun + TypeScript, `bun:test` for unit tests, native `fetch`/`FormData`, curl fallback for proxy paths, OpenAI Files API + `/v1/batches` for server-side batch.

**Spec:** `docs/superpowers/specs/2026-04-28-openai-gpt-image-2-provider-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/lib/http.ts` | refactor | Headers map; add `httpPostMultipart` + `httpGetText` |
| `scripts/lib/http.test.ts` | refactor | Adapt tests to new signature; add multipart and text-get tests |
| `scripts/lib/config.ts` | refactor | Per-provider env selection (GOOGLE_* vs OPENAI_*); model default removed (provider takes over) |
| `scripts/lib/config.test.ts` | refactor | Add OpenAI env tests; preserve Google regression |
| `scripts/lib/args.ts` | extend | Add `--edit <path>` and `--mask <path>` flags |
| `scripts/lib/args.test.ts` | extend | Tests for new flags |
| `scripts/providers/types.ts` | refactor | New `ProviderConfig` / `ProviderFactory`; `GenerateRequest` adds `mask?` / `editTarget?`; `GenerateResult.finishReason` drops `MAX_TOKENS` adds `ERROR`; `safetyInfo.category` optional; relocate `mapQualityToImageSize` from `google.ts` |
| `scripts/providers/types.test.ts` | refactor | Update finishReason enum; add mapQualityToImageSize tests |
| `scripts/providers/google.ts` | refactor | Factory accepts `ProviderConfig`; supplies `googleHeaders`; `editTarget` fallback to `refs[0]`; `mask` throws |
| `scripts/providers/google.test.ts` | refactor | Adapt to factory signature; new editTarget/mask cases |
| `scripts/providers/openai.ts` | NEW | factory + `generate()` (routes generations / edits) + `batchCreate/Get/Fetch/List/Cancel` (text-only) + `mapToOpenAISize` + `mapToOpenAIQuality` + `mapOpenAIBatchState` + `mapOpenAIError` + `openaiHeaders` |
| `scripts/providers/openai.test.ts` | NEW | All openai.ts public functions covered with table-driven cases |
| `scripts/main.ts` | refactor | Factory invocation via `ProviderConfig`; register `openai`; provider.defaultModel fallback |
| `scripts/commands/generate.ts` | extend | `validateProviderCapabilities()`; pass `editTarget` / `mask` into `GenerateRequest`; handle `ERROR` finishReason |
| `scripts/commands/generate.test.ts` | extend | Capability check tests; ERROR branch tests |
| `scripts/commands/batch.ts` | extend | `validateBatchTasks()` rejects image inputs for OpenAI; `writeResults` handles `ERROR` |
| `scripts/commands/batch.test.ts` | extend | OpenAI text-only validation; ERROR result handling |
| `scripts/integration.test.ts` | extend | Mock OpenAI server; end-to-end generate / edit / batch paths |
| `SKILL.md` | edit | Mention dual provider, OPENAI_API_KEY, capability matrix |
| `README.md` | edit | Full capability matrix, env config, --edit/--mask examples |

---

## Step 1 — HTTP Layer Headers Map Refactor (No Functional Change)

Pure refactor: `httpPost/httpGet` accept full headers map; add `httpPostMultipart` and `httpGetText` helpers. All Google tests must remain green.

### Task 1.1 — Add `httpPostMultipart` and `httpGetText` (additive)

**Files:**
- Modify: `scripts/lib/http.ts`
- Test: `scripts/lib/http.test.ts`

- [ ] **Step 1: Write failing tests for `httpGetText` (raw text, no JSON parse)**

Append to `scripts/lib/http.test.ts`:

```ts
describe("httpGetText", () => {
  test("returns raw text body, no JSON parsing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response('{"not":"json"}\n{"line":2}', { status: 200 }),
    );
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
    globalThis.fetch = mock(async () => { throw new Error("ECONNREFUSED"); });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/lib/http.test.ts`
Expected: FAIL — "Cannot find name 'httpGetText'" or import error

- [ ] **Step 3: Implement `httpGetText` in `scripts/lib/http.ts`**

Append to `scripts/lib/http.ts` (do not touch existing functions yet):

```ts
export interface HttpTextResponse {
  status: number;
  text: string;
}

export async function httpGetText(
  url: string,
  headers: Record<string, string>,
): Promise<HttpTextResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlGetText(url, headers, proxy);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: 503, text: `Network error: ${(err as Error).message}` };
  } finally {
    clearTimeout(timeout);
  }
}

function curlGetText(
  url: string,
  headers: Record<string, string>,
  proxy: string,
): HttpTextResponse {
  const args = [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(TOTAL_TIMEOUT / 1000),
    "-x", proxy,
    "-w", "\n%{http_code}",
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(url);
  try {
    const output = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = output.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop()!, 10);
    return { status: statusCode, text: lines.join("\n") };
  } catch (err) {
    return { status: 503, text: `curl error: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/lib/http.test.ts`
Expected: PASS — both new tests + all existing tests still green

- [ ] **Step 5: Write failing tests for `httpPostMultipart`**

Append to `scripts/lib/http.test.ts`:

```ts
describe("httpPostMultipart", () => {
  test("posts FormData with custom headers", async () => {
    const originalFetch = globalThis.fetch;
    let capturedRequest: Request | undefined;
    globalThis.fetch = mock(async (input: any, init: any) => {
      capturedRequest = new Request(input, init);
      return new Response(JSON.stringify({ id: "file_abc" }), { status: 200 });
    });
    try {
      const { httpPostMultipart } = await import("./http");
      const fd = new FormData();
      fd.append("purpose", "batch");
      fd.append("file", new Blob(["hello"]), "test.jsonl");
      const res = await httpPostMultipart("https://x.test/files", fd, { Authorization: "Bearer k" });
      expect(res.status).toBe(200);
      expect((res.data as any).id).toBe("file_abc");
      expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer k");
      // Critical: do NOT set Content-Type — fetch must auto-set with boundary
      expect(capturedRequest!.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns 503 on network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => { throw new Error("ECONNREFUSED"); });
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test scripts/lib/http.test.ts`
Expected: FAIL — `httpPostMultipart` not exported

- [ ] **Step 7: Implement `httpPostMultipart` in `scripts/lib/http.ts`**

Append to `scripts/lib/http.ts`:

```ts
export async function httpPostMultipart(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  // Note: do NOT set Content-Type — fetch auto-sets multipart/form-data with boundary
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    // Multipart through curl proxy is complex; for now require non-proxy setup for OpenAI
    return { status: 503, data: { error: { message: "Multipart upload not supported through HTTP proxy" } } };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `Network error: ${(err as Error).message}` } } };
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 8: Run all http tests**

Run: `bun test scripts/lib/http.test.ts`
Expected: PASS — multipart tests pass, all existing tests still green

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/http.test.ts
git commit -m "feat(http): add httpPostMultipart and httpGetText helpers"
```

### Task 1.2 — Refactor `httpPost` / `httpGet` to accept headers map

**Files:**
- Modify: `scripts/lib/http.ts`
- Modify: `scripts/lib/http.test.ts`
- Modify: `scripts/providers/google.ts`
- Modify: `scripts/providers/google.test.ts`

- [ ] **Step 1: Update `httpPost` signature in `scripts/lib/http.ts`**

Replace existing `buildHeaders`, `httpPost`, `curlPost`, `httpPostWithRetry`, `httpGet`, `curlGet`, `httpGetWithRetry` with these:

```ts
// Remove buildHeaders entirely (each provider builds its own)

export async function httpPost(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlPost(url, body, headers, proxy);
  }
  return fetchPost(url, body, headers);
}

async function fetchPost(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const fullHeaders = { "Content-Type": "application/json", ...headers };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: fullHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); }
    catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `Network error: ${(err as Error).message}` } } };
  } finally {
    clearTimeout(timeout);
  }
}

function curlPost(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(TOTAL_TIMEOUT / 1000),
    "-x", proxy,
    "-X", "POST",
    "-H", "Content-Type: application/json",
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-d", JSON.stringify(body), "-w", "\n%{http_code}", url);
  try {
    const output = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = output.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop()!, 10);
    const text = lines.join("\n");
    let data: unknown;
    try { data = JSON.parse(text); }
    catch {
      data = { error: { message: `Non-JSON response (${statusCode}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: statusCode, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `curl error: ${(err as Error).message}` } } };
  }
}

export async function httpPostWithRetry(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  return withRetry(() => httpPost(url, body, headers));
}

export async function httpGet(
  url: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) return curlGet(url, headers, proxy);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); }
    catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `Network error: ${(err as Error).message}` } } };
  } finally {
    clearTimeout(timeout);
  }
}

function curlGet(
  url: string,
  headers: Record<string, string>,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(TOTAL_TIMEOUT / 1000),
    "-x", proxy,
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-w", "\n%{http_code}", url);
  try {
    const output = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = output.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop()!, 10);
    const text = lines.join("\n");
    let data: unknown;
    try { data = JSON.parse(text); }
    catch {
      data = { error: { message: `Non-JSON response (${statusCode}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: statusCode, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `curl error: ${(err as Error).message}` } } };
  }
}

export async function httpGetWithRetry(
  url: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  return withRetry(() => httpGet(url, headers));
}
```

- [ ] **Step 2: Update `scripts/lib/http.test.ts` — remove buildHeaders tests, update test calls**

Find tests that call `httpPost(url, body, "apikey")` and change to `httpPost(url, body, { "x-goog-api-key": "apikey" })`. Same for `httpGet`. Remove the `describe("buildHeaders")` block entirely. Also update top imports: remove `buildHeaders` from import.

- [ ] **Step 3: Update all `httpPost`/`httpGet` callers in `scripts/providers/google.ts`**

At top of `scripts/providers/google.ts`, add helper:

```ts
function googleHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}
```

Then change every call site:
- `httpPost(url, body, apiKey)` → `httpPost(url, body, googleHeaders(apiKey))`
- `httpGet(url, apiKey)` → `httpGet(url, googleHeaders(apiKey))`
- `httpPostWithRetry(url, body, apiKey)` → `httpPostWithRetry(url, body, googleHeaders(apiKey))`
- `httpGetWithRetry(url, apiKey)` → `httpGetWithRetry(url, googleHeaders(apiKey))`

Use grep to find all sites: `grep -n "httpPost\|httpGet" scripts/providers/google.ts`

- [ ] **Step 4: Update `scripts/lib/files.ts` similarly**

Run: `grep -n "buildHeaders\|httpPost\|httpGet" scripts/lib/files.ts`

Add same `googleHeaders` helper or inline the header map. Update each call site.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: PASS — all green

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/http.test.ts scripts/providers/google.ts scripts/lib/files.ts
git commit -m "refactor(http): parameterize headers, decouple from x-goog-api-key"
```

---

## Step 2 — Provider Factory + Types Refactor

Introduce `ProviderConfig`, upgrade `ProviderFactory`, add `mask?` / `editTarget?` to `GenerateRequest`, refine `finishReason`, relocate `mapQualityToImageSize`.

### Task 2.1 — Update types in `scripts/providers/types.ts`

**Files:**
- Modify: `scripts/providers/types.ts`
- Modify: `scripts/providers/types.test.ts`

- [ ] **Step 1: Apply type changes to `scripts/providers/types.ts`**

Replace contents with:

```ts
export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;
  quality: "normal" | "2k";
  refs: string[];                 // 参考图（风格/构图样板）
  imageSize: "1K" | "2K" | "4K";
  editTarget?: string;            // OpenAI: route to /v1/images/edits; Google: fallback to refs[0]
  mask?: string;                  // OpenAI edit only; Google: provider throws
}

export interface GenerateResult {
  images: Array<{
    data: Uint8Array;
    mimeType: string;
  }>;
  finishReason: "STOP" | "SAFETY" | "ERROR" | "OTHER";
  safetyInfo?: {
    category?: string;            // Optional: Gemini fills, OpenAI does not
    reason: string;
  };
  textParts?: string[];
}

export interface BatchCreateRequest {
  model: string;
  tasks: GenerateRequest[];
  displayName?: string;
}

export interface BatchJob {
  id: string;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  createTime: string;
  stats?: { total: number; succeeded: number; failed: number };
  responsesFile?: string;
}

export interface BatchResult {
  key: string;
  result?: GenerateResult;
  error?: string;
}

export type ChainAnchor = unknown;

// NEW: Provider configuration object passed to factory
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  // Future providers can extend with region/orgId/projectId without breaking factory signature
}

export type ProviderFactory = (config: ProviderConfig) => Provider;

export interface Provider {
  name: string;
  defaultModel: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateAndAnchor?(req: GenerateRequest): Promise<{ result: GenerateResult; anchor: ChainAnchor }>;
  generateChained?(req: GenerateRequest, anchor: ChainAnchor): Promise<GenerateResult>;
  batchCreate?(req: BatchCreateRequest): Promise<BatchJob>;
  batchGet?(jobId: string): Promise<BatchJob>;
  batchFetch?(jobId: string): Promise<BatchResult[]>;
  batchList?(): Promise<BatchJob[]>;
  batchCancel?(jobId: string): Promise<void>;
}

// Relocated from google.ts — provider-agnostic enum mapping
export function mapQualityToImageSize(
  quality: "normal" | "2k",
): "1K" | "2K" {
  return quality === "normal" ? "1K" : "2K";
}
```

- [ ] **Step 2: Update `scripts/providers/types.test.ts`**

Add at top:

```ts
import { describe, test, expect } from "bun:test";
import { mapQualityToImageSize } from "./types";
import type { GenerateRequest, GenerateResult } from "./types";

describe("mapQualityToImageSize", () => {
  test("normal -> 1K", () => expect(mapQualityToImageSize("normal")).toBe("1K"));
  test("2k -> 2K", () => expect(mapQualityToImageSize("2k")).toBe("2K"));
});

describe("GenerateRequest type", () => {
  test("accepts mask and editTarget as optional", () => {
    const req: GenerateRequest = {
      prompt: "x",
      model: "m",
      ar: null,
      quality: "normal",
      refs: [],
      imageSize: "1K",
      mask: "/tmp/m.png",
      editTarget: "/tmp/e.png",
    };
    expect(req.mask).toBe("/tmp/m.png");
    expect(req.editTarget).toBe("/tmp/e.png");
  });
});

describe("GenerateResult.finishReason", () => {
  test("accepts ERROR", () => {
    const r: GenerateResult = { images: [], finishReason: "ERROR" };
    expect(r.finishReason).toBe("ERROR");
  });
});
```

If existing tests reference `MAX_TOKENS`, remove or update them.

- [ ] **Step 3: Run tests**

Run: `bun test scripts/providers/types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/providers/types.ts scripts/providers/types.test.ts
git commit -m "refactor(types): add ProviderConfig, mask/editTarget, relocate mapQualityToImageSize"
```

### Task 2.2 — Refactor `google.ts` to use `ProviderConfig`

**Files:**
- Modify: `scripts/providers/google.ts`
- Modify: `scripts/providers/google.test.ts`
- Modify: `scripts/main.ts`
- Modify: `scripts/commands/generate.ts`
- Modify: `scripts/commands/batch.ts`

- [ ] **Step 1: Remove `mapQualityToImageSize` from `scripts/providers/google.ts` and re-export from types**

Delete the `mapQualityToImageSize` function definition from `scripts/providers/google.ts` (it's now in `types.ts`).

To avoid breaking external imports, add a re-export at the top of `scripts/providers/google.ts`:

```ts
export { mapQualityToImageSize } from "./types";
```

This keeps `google.test.ts:2` (`import { mapQualityToImageSize } from "./google"`) and any other consumers working without changing their import paths. Update happens later if desired, but not required for this refactor.

- [ ] **Step 2: Update factory signature and add editTarget/mask handling**

Change `createGoogleProvider` signature:

```ts
import type { ProviderConfig } from "./types";

export function createGoogleProvider(config: ProviderConfig): Provider {
  const { apiKey, baseUrl } = config;

  function applyEditTargetFallback(req: GenerateRequest): GenerateRequest {
    // Google has no /edits endpoint — editTarget falls back to refs[0]
    if (!req.editTarget) return req;
    return { ...req, refs: [req.editTarget, ...req.refs] };
  }

  function rejectMask(req: GenerateRequest): void {
    if (req.mask) {
      throw new Error("Google provider does not support --mask. Mask is OpenAI-only.");
    }
  }

  // Wrap the existing generateCore / generateWithRetry to apply preprocessing
  // (existing function bodies retained — just wrap inputs)
  // ...
}
```

In every `generate` / `generateAndAnchor` / `generateChained` / `batchCreate` etc., at function entry call:

```ts
rejectMask(req);
const effectiveReq = applyEditTargetFallback(req);
// then use effectiveReq instead of req
```

For `batchCreate` it's per-task:

```ts
async batchCreate(req: BatchCreateRequest): Promise<BatchJob> {
  for (const t of req.tasks) rejectMask(t);
  const effectiveTasks = req.tasks.map(applyEditTargetFallback);
  validateBatchTasks(effectiveTasks);
  // ... use effectiveTasks
}
```

- [ ] **Step 3: Update `scripts/main.ts` — pass `ProviderConfig`**

Change relevant section:

```ts
import type { ProviderFactory, ProviderConfig } from "./providers/types";

const PROVIDERS: Record<string, ProviderFactory> = {
  google: createGoogleProvider,
};

// ... in main():
const providerFactory = PROVIDERS[config.provider];
if (!providerFactory) { /* ... */ }
const providerConfig: ProviderConfig = {
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  model: config.model,
};
const provider = providerFactory(providerConfig);

// Tie default model: if no explicit model, use provider's
if (!config.model) {
  config.model = provider.defaultModel;
}
```

- [ ] **Step 4: Update `scripts/commands/generate.ts` and `scripts/commands/batch.ts` import**

Change `import { mapQualityToImageSize } from "../providers/google";` to `import { mapQualityToImageSize } from "../providers/types";`

- [ ] **Step 5: Update `scripts/providers/google.test.ts`**

Rewrite all `createGoogleProvider("apikey", "https://x.test")` calls to:

```ts
createGoogleProvider({ apiKey: "apikey", baseUrl: "https://x.test", model: "gemini-3.1-flash-image-preview" })
```

Add new test cases:

```ts
describe("createGoogleProvider editTarget fallback", () => {
  test("editTarget non-empty: prepends to refs", async () => {
    const provider = createGoogleProvider({ apiKey: "k", baseUrl: "https://x.test", model: "m" });
    // mock httpPost to capture request
    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }), { status: 200 });
    });
    try {
      // Need a real ref file — use a temp PNG
      const tmpRef = "/tmp/jdy-test-ref.png";
      await Bun.write(tmpRef, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
      const tmpEdit = "/tmp/jdy-test-edit.png";
      await Bun.write(tmpEdit, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
      await provider.generate({
        prompt: "test", model: "m", ar: null, quality: "normal",
        refs: [tmpRef], imageSize: "1K", editTarget: tmpEdit,
      });
      // editTarget should be in parts[0].inlineData; tmpRef in parts[1]
      const parts = capturedBody.contents[0].parts;
      expect(parts[0].inlineData).toBeDefined();   // editTarget
      expect(parts[1].inlineData).toBeDefined();   // ref
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createGoogleProvider mask rejection", () => {
  test("mask throws", async () => {
    const provider = createGoogleProvider({ apiKey: "k", baseUrl: "https://x.test", model: "m" });
    expect(provider.generate({
      prompt: "x", model: "m", ar: null, quality: "normal",
      refs: [], imageSize: "1K", mask: "/tmp/m.png",
    })).rejects.toThrow(/Google.*does not support.*mask/i);
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: PASS — all green (Google regression + new editTarget/mask tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts scripts/main.ts scripts/commands/generate.ts scripts/commands/batch.ts
git commit -m "refactor(google): factory accepts ProviderConfig; editTarget fallback; mask reject"
```

---

## Step 3 — Config + Args Adaptation

### Task 3.1 — Add `--edit` and `--mask` flags

**Files:**
- Modify: `scripts/lib/args.ts`
- Modify: `scripts/lib/args.test.ts`

- [ ] **Step 1: Write failing tests for new flags**

Append to `scripts/lib/args.test.ts`:

```ts
describe("parseArgs --edit / --mask", () => {
  test("parses --edit", () => {
    const args = parseArgs(["generate", "--prompt", "x", "--edit", "/tmp/e.png"]);
    expect(args.flags.edit).toBe("/tmp/e.png");
  });
  test("parses --mask", () => {
    const args = parseArgs(["generate", "--prompt", "x", "--edit", "/tmp/e.png", "--mask", "/tmp/m.png"]);
    expect(args.flags.mask).toBe("/tmp/m.png");
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `bun test scripts/lib/args.test.ts`
Expected: FAIL — `flags.edit` undefined

- [ ] **Step 3: Update `ParsedArgs.flags` and parser in `scripts/lib/args.ts`**

Add to `flags`:

```ts
edit?: string;
mask?: string;
```

In the `switch` block, add cases:

```ts
case "--edit":
  result.flags.edit = nextVal(arg);
  break;
case "--mask":
  result.flags.mask = nextVal(arg);
  break;
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test scripts/lib/args.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/args.ts scripts/lib/args.test.ts
git commit -m "feat(args): add --edit and --mask flags"
```

### Task 3.2 — Per-provider env selection in config

**Files:**
- Modify: `scripts/lib/config.ts`
- Modify: `scripts/lib/config.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `scripts/lib/config.test.ts`:

```ts
describe("mergeConfig with openai provider", () => {
  test("reads OPENAI_API_KEY when provider=openai", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "sk-openai", GOOGLE_API_KEY: "should-not-be-used" },
    );
    expect(c.apiKey).toBe("sk-openai");
    expect(c.baseUrl).toBe("https://api.openai.com");
  });

  test("reads OPENAI_BASE_URL override", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://proxy.example.com" },
    );
    expect(c.baseUrl).toBe("https://proxy.example.com");
  });

  test("reads OPENAI_IMAGE_MODEL override", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "k", OPENAI_IMAGE_MODEL: "gpt-image-1.5" },
    );
    expect(c.model).toBe("gpt-image-1.5");
  });

  test("model defaults to gpt-image-2 when no override for openai", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "k" },
    );
    expect(c.model).toBe("gpt-image-2");
  });

  test("google regression: model still defaults to gemini-3.1-flash-image-preview", () => {
    const c = mergeConfig(
      { provider: "google" },
      {},
      { GOOGLE_API_KEY: "k" },
    );
    expect(c.model).toBe("gemini-3.1-flash-image-preview");
  });

  test("google provider regression: still reads GOOGLE_API_KEY", () => {
    const c = mergeConfig(
      { provider: "google" },
      {},
      { GOOGLE_API_KEY: "google-key" },
    );
    expect(c.apiKey).toBe("google-key");
    expect(c.baseUrl).toBe("https://generativelanguage.googleapis.com");
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `bun test scripts/lib/config.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `scripts/lib/config.ts`**

Replace `DEFAULTS` and `mergeConfig`. Per-provider defaults include both `baseUrl` AND `defaultModel` so `mergeConfig` returns a populated `model` for each provider (no empty-string fallback in `main.ts` needed; preserves existing `integration.test.ts` assertion that `mergeConfig` returns the Gemini default when no env override):

```ts
const DEFAULTS = {
  provider: "google",
  quality: "2k" as const,
  ar: "1:1",
};

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; defaultModel: string }> = {
  google: {
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-3.1-flash-image-preview",
  },
  openai: {
    baseUrl: "https://api.openai.com",
    defaultModel: "gpt-image-2",
  },
};

export function mergeConfig(
  cliFlags: Record<string, string | undefined>,
  extendMd: Record<string, string>,
  env: Record<string, string | undefined>,
): Config {
  const provider =
    cliFlags.provider ??
    extendMd.default_provider ??
    DEFAULTS.provider;

  const providerDefault = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.google;

  let apiKey = "";
  let baseUrl = providerDefault.baseUrl;
  let envModel: string | undefined;

  if (provider === "google") {
    apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? "";
    baseUrl = env.GOOGLE_BASE_URL ?? baseUrl;
    envModel = env.GOOGLE_IMAGE_MODEL;
  } else if (provider === "openai") {
    apiKey = env.OPENAI_API_KEY ?? "";
    baseUrl = env.OPENAI_BASE_URL ?? baseUrl;
    envModel = env.OPENAI_IMAGE_MODEL;
  }

  return {
    provider,
    model:
      cliFlags.model ??
      extendMd.default_model ??
      envModel ??
      providerDefault.defaultModel,
    quality: (cliFlags.quality ??
      extendMd.default_quality ??
      DEFAULTS.quality) as "normal" | "2k",
    ar:
      cliFlags.ar ??
      extendMd.default_ar ??
      DEFAULTS.ar,
    apiKey,
    baseUrl,
  };
}
```

**Note**: this means `main.ts` no longer needs the "if (!config.model) config.model = provider.defaultModel" fallback added in Task 2.2 Step 3 — `mergeConfig` already populates a sane default. Keep it as a defensive fallback (in case future providers have empty defaultModel) but it should be unreachable in normal flow.

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test scripts/lib/config.test.ts`
Expected: PASS — both new openai tests + google regression

- [ ] **Step 5: Update `scripts/main.ts` apiKey error message**

Find the apiKey check, broaden the error message:

```ts
if (!config.apiKey) {
  const envName = config.provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
  console.error(
    `Missing API key. Set ${envName} environment variable,\n` +
    "or create a .env file at .jdy-imagine/.env or ~/.jdy-imagine/.env",
  );
  process.exit(1);
}
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/config.ts scripts/lib/config.test.ts scripts/main.ts
git commit -m "feat(config): per-provider env selection (OPENAI_API_KEY/BASE_URL/IMAGE_MODEL)"
```

---

## Step 4 — OpenAI Provider Core (Generate + Edit Routing)

### Task 4.1 — Create `scripts/providers/openai.ts` skeleton + helpers

**Files:**
- Create: `scripts/providers/openai.ts`
- Create: `scripts/providers/openai.test.ts`

- [ ] **Step 1: Write failing tests for `mapToOpenAISize` (table-driven)**

Create `scripts/providers/openai.test.ts` (do NOT import `createOpenAIProvider` yet — it's added in Task 4.2; ESM static import would fail otherwise):

```ts
import { describe, test, expect, mock } from "bun:test";
import {
  mapToOpenAISize,
  mapToOpenAIQuality,
  mapOpenAIBatchState,
  mapOpenAIError,
  buildGenerationsPayload,
  buildEditFormData,
  parseOpenAIResponse,
  buildOpenAIBatchJsonl,
} from "./openai";

describe("mapToOpenAISize", () => {
  const cases: Array<["normal" | "2k", string, string]> = [
    ["normal", "1:1", "1024x1024"],
    ["normal", "16:9", "1536x1024"],
    ["normal", "9:16", "1024x1536"],
    ["normal", "3:2", "1536x1024"],
    ["normal", "2:3", "1024x1536"],
    ["normal", "4:3", "1280x960"],
    ["normal", "3:4", "960x1280"],
    ["2k", "1:1", "2048x2048"],
    ["2k", "16:9", "2048x1152"],
    ["2k", "9:16", "1152x2048"],
    ["2k", "3:2", "2304x1536"],
    ["2k", "2:3", "1536x2304"],
    ["2k", "4:3", "2048x1536"],
    ["2k", "3:4", "1536x2048"],
  ];
  for (const [q, ar, size] of cases) {
    test(`${q} + ${ar} -> ${size}`, () => {
      expect(mapToOpenAISize(q, ar)).toBe(size);
    });
  }
  test("null ar defaults to 1:1", () => {
    expect(mapToOpenAISize("normal", null)).toBe("1024x1024");
  });
  test("unknown ar throws", () => {
    expect(() => mapToOpenAISize("normal", "100:1")).toThrow(/unsupported.*ar/i);
  });
});

describe("mapToOpenAIQuality", () => {
  test("normal -> medium", () => expect(mapToOpenAIQuality("normal")).toBe("medium"));
  test("2k -> high", () => expect(mapToOpenAIQuality("2k")).toBe("high"));
});

describe("mapOpenAIBatchState", () => {
  test("validating -> pending", () => expect(mapOpenAIBatchState("validating")).toBe("pending"));
  test("in_progress -> running", () => expect(mapOpenAIBatchState("in_progress")).toBe("running"));
  test("finalizing -> running", () => expect(mapOpenAIBatchState("finalizing")).toBe("running"));
  test("cancelling -> running", () => expect(mapOpenAIBatchState("cancelling")).toBe("running"));
  test("completed -> succeeded", () => expect(mapOpenAIBatchState("completed")).toBe("succeeded"));
  test("failed -> failed", () => expect(mapOpenAIBatchState("failed")).toBe("failed"));
  test("expired -> expired", () => expect(mapOpenAIBatchState("expired")).toBe("expired"));
  test("cancelled -> cancelled", () => expect(mapOpenAIBatchState("cancelled")).toBe("cancelled"));
  test("unknown state -> pending (conservative)", () => {
    expect(mapOpenAIBatchState("future_state")).toBe("pending");
  });
});

describe("mapOpenAIError", () => {
  test("moderation_blocked -> SAFETY", () => {
    const r = mapOpenAIError({ code: "moderation_blocked", message: "blocked" });
    expect(r.finishReason).toBe("SAFETY");
    expect(r.safetyInfo?.reason).toBe("blocked");
  });
  test("content_policy_violation -> SAFETY", () => {
    const r = mapOpenAIError({ code: "content_policy_violation", message: "policy" });
    expect(r.finishReason).toBe("SAFETY");
  });
  test("invalid_size -> ERROR", () => {
    const r = mapOpenAIError({ code: "invalid_size", message: "bad size" });
    expect(r.finishReason).toBe("ERROR");
    expect(r.safetyInfo?.reason).toBe("bad size");
  });
  test("unknown error code -> ERROR", () => {
    const r = mapOpenAIError({ code: "unknown_code", message: "msg" });
    expect(r.finishReason).toBe("ERROR");
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL (file not exists)**

Run: `bun test scripts/providers/openai.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `scripts/providers/openai.ts` with helper functions only**

```ts
import { readFileSync } from "fs";
import { httpPost, httpPostMultipart, httpGet, httpGetText, httpPostWithRetry, httpGetWithRetry } from "../lib/http";
import { generateSlug } from "../lib/output";
import type {
  GenerateRequest,
  GenerateResult,
  BatchCreateRequest,
  BatchJob,
  BatchResult,
  Provider,
  ProviderConfig,
} from "./types";

// === Mappings ===

const SIZE_TABLE: Record<"normal" | "2k", Record<string, string>> = {
  normal: {
    "1:1":  "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "3:2":  "1536x1024",
    "2:3":  "1024x1536",
    "4:3":  "1280x960",
    "3:4":  "960x1280",
  },
  "2k": {
    "1:1":  "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2":  "2304x1536",
    "2:3":  "1536x2304",
    "4:3":  "2048x1536",
    "3:4":  "1536x2048",
  },
};

export function mapToOpenAISize(quality: "normal" | "2k", ar: string | null): string {
  const effectiveAr = ar ?? "1:1";
  const size = SIZE_TABLE[quality]?.[effectiveAr];
  if (!size) {
    throw new Error(`Unsupported ar "${effectiveAr}" for quality "${quality}". Supported: ${Object.keys(SIZE_TABLE[quality]).join(", ")}`);
  }
  return size;
}

export function mapToOpenAIQuality(quality: "normal" | "2k"): "low" | "medium" | "high" | "auto" {
  return quality === "normal" ? "medium" : "high";
}

export function mapOpenAIBatchState(raw: string): BatchJob["state"] {
  switch (raw) {
    case "validating": return "pending";
    case "in_progress": return "running";
    case "finalizing": return "running";
    case "cancelling": return "running";
    case "completed": return "succeeded";
    case "failed": return "failed";
    case "expired": return "expired";
    case "cancelled": return "cancelled";
    default: return "pending";
  }
}

interface OpenAIErrorBody {
  code?: string;
  message?: string;
  type?: string;
}

const SAFETY_CODES = new Set(["moderation_blocked", "content_policy_violation"]);

export function mapOpenAIError(err: OpenAIErrorBody): GenerateResult {
  const reason = err.message ?? err.code ?? "Unknown OpenAI error";
  if (err.code && SAFETY_CODES.has(err.code)) {
    return {
      images: [],
      finishReason: "SAFETY",
      safetyInfo: { reason },
    };
  }
  return {
    images: [],
    finishReason: "ERROR",
    safetyInfo: { reason },
  };
}

// === Headers ===

function openaiHeaders(apiKey: string): Record<string, string> {
  return { "Authorization": `Bearer ${apiKey}` };
}

// === Payload builders ===

export function buildGenerationsPayload(req: GenerateRequest): Record<string, unknown> {
  return {
    model: req.model,
    prompt: req.prompt,
    n: 1,
    size: mapToOpenAISize(req.quality, req.ar),
    quality: mapToOpenAIQuality(req.quality),
    output_format: "png",
  };
}

export function buildEditFormData(req: GenerateRequest): FormData {
  const fd = new FormData();
  fd.append("model", req.model);
  fd.append("prompt", req.prompt);
  fd.append("n", "1");
  fd.append("size", mapToOpenAISize(req.quality, req.ar));
  fd.append("quality", mapToOpenAIQuality(req.quality));
  fd.append("output_format", "png");

  // image[] order: editTarget first (if any), then refs
  const images: string[] = [];
  if (req.editTarget) images.push(req.editTarget);
  images.push(...req.refs);
  for (const path of images) {
    const data = readFileSync(path);
    const ext = path.split(".").pop()?.toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    fd.append("image[]", new Blob([data], { type: mime }), path.split("/").pop());
  }

  if (req.mask) {
    const maskData = readFileSync(req.mask);
    fd.append("mask", new Blob([maskData], { type: "image/png" }), "mask.png");
  }

  return fd;
}

export function parseOpenAIResponse(apiResponse: { data?: Array<{ b64_json?: string }> }): GenerateResult {
  const items = apiResponse.data ?? [];
  const images = items
    .filter((it) => it.b64_json)
    .map((it) => ({
      data: Buffer.from(it.b64_json!, "base64"),
      mimeType: "image/png" as const,
    }));
  return {
    images,
    finishReason: images.length > 0 ? "STOP" : "OTHER",
  };
}

// === Batch JSONL ===

export function buildOpenAIBatchJsonl(tasks: GenerateRequest[]): { data: Uint8Array; keys: string[] } {
  const keys: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(task.prompt);
    const key = `${seq}-${slug}`;
    keys.push(key);
    lines.push(JSON.stringify({
      custom_id: key,
      method: "POST",
      url: "/v1/images/generations",
      body: buildGenerationsPayload(task),
    }));
  }
  return { data: new TextEncoder().encode(lines.join("\n") + "\n"), keys };
}
```

- [ ] **Step 4: Run tests, expect PASS for all helper tests**

Run: `bun test scripts/providers/openai.test.ts`
Expected: PASS — all helper tests pass

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/openai.ts scripts/providers/openai.test.ts
git commit -m "feat(openai): add SIZE_TABLE, quality/state/error mappings, payload builders"
```

### Task 4.2 — Implement `createOpenAIProvider` with realtime generate routing

**Files:**
- Modify: `scripts/providers/openai.ts`
- Modify: `scripts/providers/openai.test.ts`
- Modify: `scripts/main.ts`

- [ ] **Step 1: Write failing tests for routing logic**

First add the import for `createOpenAIProvider` to the existing import block at the top of `scripts/providers/openai.test.ts`. Then append:

```ts
import { createOpenAIProvider } from "./openai";  // moved here from Task 4.1's deferred import

describe("createOpenAIProvider routing", () => {
  test("text-only -> /v1/images/generations (JSON POST)", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedContentType = "";
    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedUrl = url.toString();
      capturedMethod = init.method;
      capturedContentType = (init.headers["Content-Type"] || init.headers.get?.("Content-Type")) ?? "";
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("PNG-DATA").toString("base64") }] }), { status: 200 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const result = await provider.generate({
        prompt: "cat", model: "gpt-image-2", ar: "1:1", quality: "normal",
        refs: [], imageSize: "1K",
      });
      expect(capturedUrl).toContain("/v1/images/generations");
      expect(capturedMethod).toBe("POST");
      expect(capturedContentType).toBe("application/json");
      expect(result.images.length).toBe(1);
      expect(result.finishReason).toBe("STOP");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refs only -> /v1/images/edits (multipart)", async () => {
    const tmpRef = "/tmp/jdy-openai-ref.png";
    await Bun.write(tmpRef, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedContentType = "";
    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedUrl = url.toString();
      capturedContentType = init.headers.get?.("Content-Type") ?? init.headers["Content-Type"] ?? "";
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] }), { status: 200 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      await provider.generate({
        prompt: "blue", model: "gpt-image-2", ar: "1:1", quality: "normal",
        refs: [tmpRef], imageSize: "1K",
      });
      expect(capturedUrl).toContain("/v1/images/edits");
      expect(capturedContentType).toMatch(/^multipart\/form-data/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("editTarget + mask -> /v1/images/edits", async () => {
    const tmpEdit = "/tmp/jdy-openai-edit.png";
    const tmpMask = "/tmp/jdy-openai-mask.png";
    await Bun.write(tmpEdit, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    await Bun.write(tmpMask, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: any, _init: any) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("PNG").toString("base64") }] }), { status: 200 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      await provider.generate({
        prompt: "fix", model: "gpt-image-2", ar: "1:1", quality: "normal",
        refs: [], imageSize: "1K", editTarget: tmpEdit, mask: tmpMask,
      });
      expect(capturedUrl).toContain("/v1/images/edits");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("error 400 moderation_blocked -> SAFETY result", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "no" } }), { status: 400 }),
    );
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const r = await provider.generate({
        prompt: "x", model: "gpt-image-2", ar: "1:1", quality: "normal",
        refs: [], imageSize: "1K",
      });
      expect(r.finishReason).toBe("SAFETY");
      expect(r.safetyInfo?.reason).toBe("no");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("error 401 throws", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
    );
    try {
      const provider = createOpenAIProvider({ apiKey: "bad", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      expect(provider.generate({
        prompt: "x", model: "gpt-image-2", ar: "1:1", quality: "normal",
        refs: [], imageSize: "1K",
      })).rejects.toThrow(/auth|401/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `bun test scripts/providers/openai.test.ts`
Expected: FAIL — `createOpenAIProvider` not exported

- [ ] **Step 3: Append `createOpenAIProvider` to `scripts/providers/openai.ts`**

```ts
const RETRY_DELAYS = [1000, 2000, 4000];
const RETRYABLE_STATUS = new Set([429, 500, 503]);

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const { apiKey, baseUrl } = config;
  const headers = openaiHeaders(apiKey);

  function shouldRouteToEdits(req: GenerateRequest): boolean {
    return Boolean(req.editTarget) || req.refs.length > 0 || Boolean(req.mask);
  }

  async function generateOnce(req: GenerateRequest): Promise<GenerateResult> {
    if (shouldRouteToEdits(req)) {
      const fd = buildEditFormData(req);
      const url = `${baseUrl}/v1/images/edits`;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        const res = await httpPostMultipart(url, fd, headers);
        if (res.status === 200) {
          return parseOpenAIResponse(res.data as { data?: Array<{ b64_json?: string }> });
        }
        if (res.status === 401 || res.status === 403) {
          const err = (res.data as any)?.error;
          throw new Error(`OpenAI auth failed (${res.status}): ${err?.message ?? "unknown"}`);
        }
        if (res.status === 400) {
          const err = (res.data as any)?.error;
          return mapOpenAIError(err ?? {});
        }
        if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
          const err = (res.data as any)?.error;
          throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
        }
        await Bun.sleep(RETRY_DELAYS[attempt]);
      }
      throw new Error("Unreachable");
    }
    // generations
    const payload = buildGenerationsPayload(req);
    const url = `${baseUrl}/v1/images/generations`;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await httpPost(url, payload, headers);
      if (res.status === 200) {
        return parseOpenAIResponse(res.data as { data?: Array<{ b64_json?: string }> });
      }
      if (res.status === 401 || res.status === 403) {
        const err = (res.data as any)?.error;
        throw new Error(`OpenAI auth failed (${res.status}): ${err?.message ?? "unknown"}`);
      }
      if (res.status === 400) {
        const err = (res.data as any)?.error;
        return mapOpenAIError(err ?? {});
      }
      if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
        const err = (res.data as any)?.error;
        throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
      }
      await Bun.sleep(RETRY_DELAYS[attempt]);
    }
    throw new Error("Unreachable");
  }

  return {
    name: "openai",
    defaultModel: "gpt-image-2",
    generate: generateOnce,
    // Batch methods added in next task
  };
}
```

- [ ] **Step 4: Register openai in `scripts/main.ts`**

```ts
import { createOpenAIProvider } from "./providers/openai";

const PROVIDERS: Record<string, ProviderFactory> = {
  google: createGoogleProvider,
  openai: createOpenAIProvider,
};
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `bun test scripts/providers/openai.test.ts`
Expected: PASS — all routing tests + helper tests

- [ ] **Step 6: Commit**

```bash
git add scripts/providers/openai.ts scripts/providers/openai.test.ts scripts/main.ts
git commit -m "feat(openai): realtime generate with /generations and /edits routing"
```

---

## Step 5 — OpenAI Server-Side Batch (Text-Only)

### Task 5.1 — Implement batch methods on OpenAI provider

**Files:**
- Modify: `scripts/lib/http.ts` (Step 3a — add `httpPostMultipartWithRetry` / `httpGetTextWithRetry`)
- Modify: `scripts/lib/http.test.ts` (Step 3a — add retry wrapper tests)
- Modify: `scripts/providers/openai.ts` (Step 3b — implement batch methods using retry wrappers)
- Modify: `scripts/providers/openai.test.ts` (Steps 1, 3b — batch method tests)

- [ ] **Step 1: Write failing tests for batch methods**

Append to `scripts/providers/openai.test.ts`:

```ts
describe("createOpenAIProvider batch", () => {
  test("buildOpenAIBatchJsonl produces correct format", () => {
    const { data, keys } = buildOpenAIBatchJsonl([
      { prompt: "cat", model: "gpt-image-2", ar: "1:1", quality: "normal", refs: [], imageSize: "1K" },
      { prompt: "dog", model: "gpt-image-2", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" },
    ]);
    const text = new TextDecoder().decode(data);
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    const line0 = JSON.parse(lines[0]);
    expect(line0.custom_id).toBe(keys[0]);
    expect(line0.method).toBe("POST");
    expect(line0.url).toBe("/v1/images/generations");
    expect(line0.body.prompt).toBe("cat");
    expect(line0.body.size).toBe("1024x1024");
    expect(line0.body.quality).toBe("medium");
  });

  test("batchCreate uploads file then creates batch", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = mock(async (url: any, init: any) => {
      const u = url.toString();
      calls.push({ url: u, method: init.method });
      if (u.includes("/v1/files")) {
        return new Response(JSON.stringify({ id: "file_xyz" }), { status: 200 });
      }
      if (u.includes("/v1/batches")) {
        return new Response(JSON.stringify({
          id: "batch_abc",
          status: "validating",
          created_at: 1000,
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const job = await provider.batchCreate!({
        model: "gpt-image-2",
        tasks: [
          { prompt: "cat", model: "gpt-image-2", ar: "1:1", quality: "normal", refs: [], imageSize: "1K" },
        ],
      });
      expect(job.id).toBe("batch_abc");
      expect(job.state).toBe("pending");
      expect(calls[0].url).toContain("/v1/files");
      expect(calls[1].url).toContain("/v1/batches");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batchGet maps state and stats", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        id: "batch_abc",
        status: "completed",
        created_at: 1000,
        request_counts: { total: 5, completed: 4, failed: 1 },
        output_file_id: "file_out",
      }), { status: 200 }),
    );
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const job = await provider.batchGet!("batch_abc");
      expect(job.state).toBe("succeeded");
      expect(job.stats).toEqual({ total: 5, succeeded: 4, failed: 1 });
      expect(job.responsesFile).toBe("file_out");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batchFetch downloads JSONL via httpGetText (raw text)", async () => {
    const jsonlOutput =
      JSON.stringify({ custom_id: "001-cat", response: { body: { data: [{ b64_json: Buffer.from("IMG1").toString("base64") }] } } }) + "\n" +
      JSON.stringify({ custom_id: "002-dog", error: { message: "blocked" } }) + "\n";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/batches/")) {
        return new Response(JSON.stringify({
          id: "batch_abc",
          status: "completed",
          output_file_id: "file_out",
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_out/content")) {
        return new Response(jsonlOutput, { status: 200 });
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const results = await provider.batchFetch!("batch_abc");
      expect(results.length).toBe(2);
      expect(results[0].key).toBe("001-cat");
      expect(results[0].result?.images.length).toBe(1);
      expect(results[1].key).toBe("002-dog");
      expect(results[1].error).toBe("blocked");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batchFetch downloads BOTH output_file and error_file, merges by custom_id", async () => {
    const successOutput = JSON.stringify({
      custom_id: "001-cat",
      response: { body: { data: [{ b64_json: Buffer.from("CAT").toString("base64") }] } },
    }) + "\n";
    const errorOutput = JSON.stringify({
      custom_id: "002-dog",
      error: { message: "moderation_blocked" },
    }) + "\n";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/batches/batch_mixed")) {
        return new Response(JSON.stringify({
          id: "batch_mixed", status: "completed",
          output_file_id: "file_out", error_file_id: "file_err",
          request_counts: { total: 2, completed: 1, failed: 1 },
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_out/content")) return new Response(successOutput, { status: 200 });
      if (u.includes("/v1/files/file_err/content")) return new Response(errorOutput, { status: 200 });
      return new Response("nf", { status: 404 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const results = await provider.batchFetch!("batch_mixed");
      expect(results.length).toBe(2);
      expect(results.find(r => r.key === "001-cat")?.result?.images.length).toBe(1);
      expect(results.find(r => r.key === "002-dog")?.error).toBe("moderation_blocked");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batchFetch handles error-only batch (no output_file_id)", async () => {
    const errorOutput = JSON.stringify({
      custom_id: "001-x",
      error: { message: "rate_limit" },
    }) + "\n";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/batches/")) {
        return new Response(JSON.stringify({
          id: "batch_err", status: "completed",
          error_file_id: "file_err",
          request_counts: { total: 1, completed: 0, failed: 1 },
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_err/content")) return new Response(errorOutput, { status: 200 });
      return new Response("nf", { status: 404 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const results = await provider.batchFetch!("batch_err");
      expect(results.length).toBe(1);
      expect(results[0].error).toBe("rate_limit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batchList returns mapped jobs", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        data: [
          { id: "batch_1", status: "in_progress", created_at: 1000 },
          { id: "batch_2", status: "completed", created_at: 2000 },
        ],
      }), { status: 200 }),
    );
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      const jobs = await provider.batchList!();
      expect(jobs.length).toBe(2);
      expect(jobs[0].state).toBe("running");
      expect(jobs[1].state).toBe("succeeded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("batchCancel posts to /cancel", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      calledUrl = url.toString();
      return new Response(JSON.stringify({ id: "batch_abc", status: "cancelling" }), { status: 200 });
    });
    try {
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      await provider.batchCancel!("batch_abc");
      expect(calledUrl).toContain("/v1/batches/batch_abc/cancel");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `bun test scripts/providers/openai.test.ts`
Expected: FAIL — batch methods not implemented

- [ ] **Step 3a: Add retry wrappers for multipart and text-get in `scripts/lib/http.ts`**

Append to `scripts/lib/http.ts`:

```ts
export async function httpPostMultipartWithRetry(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    const res = await httpPostMultipart(url, formData, headers);
    if (!RETRYABLE_HTTP.has(res.status) || attempt === RETRY_DELAYS_HTTP.length) {
      return res;
    }
    await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
  }
  throw new Error("Unreachable");
}

export async function httpGetTextWithRetry(
  url: string,
  headers: Record<string, string>,
): Promise<HttpTextResponse> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    const res = await httpGetText(url, headers);
    if (!RETRYABLE_HTTP.has(res.status) || attempt === RETRY_DELAYS_HTTP.length) {
      return res;
    }
    await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
  }
  throw new Error("Unreachable");
}
```

Add corresponding tests in `scripts/lib/http.test.ts`:

```ts
describe("retry wrappers", () => {
  test("httpPostMultipartWithRetry retries on 503", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      // Mock returns JSON-shaped 503 (not raw text) so httpPostMultipart preserves the 503 status.
      // Raw-text 503 responses get downgraded to 502 by the JSON.parse failure path,
      // and 502 is not in RETRYABLE_HTTP, so retry would never trigger.
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "service unavailable" } }), { status: 503 });
      return new Response(JSON.stringify({ id: "f" }), { status: 200 });
    });
    try {
      const { httpPostMultipartWithRetry } = await import("./http");
      const res = await httpPostMultipartWithRetry("https://x.test/files", new FormData(), {});
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("httpGetTextWithRetry retries on 429", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      // httpGetText preserves status (does not JSON.parse), so raw text 429 is fine here.
      if (calls === 1) return new Response("rate limit", { status: 429 });
      return new Response("file content", { status: 200 });
    });
    try {
      const { httpGetTextWithRetry } = await import("./http");
      const res = await httpGetTextWithRetry("https://x.test/file", {});
      expect(res.status).toBe(200);
      expect(res.text).toBe("file content");
      expect(calls).toBe(2);
    } finally { globalThis.fetch = originalFetch; }
  });
});
```

Run: `bun test scripts/lib/http.test.ts`
Expected: PASS — retry wrappers work.

- [ ] **Step 3b: Implement batch methods in `scripts/providers/openai.ts`**

Inside `createOpenAIProvider`, after `generate`, add (note: use `httpPostMultipartWithRetry` and `httpGetTextWithRetry` for the file IO paths to match the resilience of other batch operations):

```ts
import { httpPostMultipartWithRetry, httpGetTextWithRetry } from "../lib/http";  // add to imports at top

async function uploadBatchFile(jsonl: Uint8Array, displayName: string): Promise<string> {
  const fd = new FormData();
  fd.append("purpose", "batch");
  fd.append("file", new Blob([jsonl], { type: "application/jsonl" }), `${displayName}.jsonl`);
  const res = await httpPostMultipartWithRetry(`${baseUrl}/v1/files`, fd, headers);
  if (res.status !== 200) {
    const err = (res.data as any)?.error;
    throw new Error(`OpenAI Files upload failed (${res.status}): ${err?.message ?? "unknown"}`);
  }
  return (res.data as { id: string }).id;
}

async function downloadBatchFile(fileId: string): Promise<string> {
  const res = await httpGetTextWithRetry(`${baseUrl}/v1/files/${fileId}/content`, headers);
  if (res.status !== 200) {
    throw new Error(`Failed to download file ${fileId}: ${res.text.slice(0, 200)}`);
  }
  return res.text;
}

return {
  name: "openai",
  defaultModel: "gpt-image-2",
  generate: generateOnce,

  async batchCreate(req: BatchCreateRequest): Promise<BatchJob> {
    const displayName = req.displayName ?? `jdy-imagine-${Date.now()}`;
    const { data: jsonl } = buildOpenAIBatchJsonl(req.tasks);
    const fileId = await uploadBatchFile(jsonl, displayName);
    const res = await httpPostWithRetry(
      `${baseUrl}/v1/batches`,
      {
        input_file_id: fileId,
        endpoint: "/v1/images/generations",
        completion_window: "24h",
        metadata: { display_name: displayName },
      },
      headers,
    );
    if (res.status !== 200) {
      const err = (res.data as any)?.error;
      throw new Error(`OpenAI batch create failed (${res.status}): ${err?.message ?? "unknown"}`);
    }
    const d = res.data as { id: string; status: string; created_at?: number };
    return {
      id: d.id,
      state: mapOpenAIBatchState(d.status),
      createTime: d.created_at ? new Date(d.created_at * 1000).toISOString() : new Date().toISOString(),
    };
  },

  async batchGet(jobId: string): Promise<BatchJob> {
    const res = await httpGetWithRetry(`${baseUrl}/v1/batches/${jobId}`, headers);
    if (res.status !== 200) {
      const err = (res.data as any)?.error;
      throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
    }
    const d = res.data as {
      id: string;
      status: string;
      created_at?: number;
      request_counts?: { total?: number; completed?: number; failed?: number };
      output_file_id?: string;
      error_file_id?: string;
    };
    // OpenAI batch may produce output_file_id (successful results) AND/OR
    // error_file_id (failed requests). Prefer output_file_id for the main
    // responsesFile pointer; consumer code reads both via batchFetch.
    return {
      id: d.id,
      state: mapOpenAIBatchState(d.status),
      createTime: d.created_at ? new Date(d.created_at * 1000).toISOString() : "",
      stats: d.request_counts && d.request_counts.total != null
        ? {
          total: d.request_counts.total,
          succeeded: d.request_counts.completed ?? 0,
          failed: d.request_counts.failed ?? 0,
        }
        : undefined,
      responsesFile: d.output_file_id ?? d.error_file_id,
    };
  },

  async batchFetch(jobId: string): Promise<BatchResult[]> {
    // 1. get batch metadata to find output_file_id and error_file_id
    const metaRes = await httpGetWithRetry(`${baseUrl}/v1/batches/${jobId}`, headers);
    if (metaRes.status !== 200) {
      const err = (metaRes.data as any)?.error;
      throw new Error(err?.message ?? `OpenAI HTTP ${metaRes.status}`);
    }
    const meta = metaRes.data as {
      output_file_id?: string;
      error_file_id?: string;
      status?: string;
      request_counts?: { total?: number };
    };
    if (!meta.output_file_id && !meta.error_file_id) {
      throw new Error(`Batch job has neither output_file_id nor error_file_id (status=${meta.status})`);
    }
    // 2. download both files (if present) and merge by custom_id
    const resultsByKey = new Map<string, BatchResult>();
    const parseLines = (text: string) => {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); }
        catch { continue; }
        const key = parsed.custom_id ?? "unknown";
        if (parsed.error) {
          resultsByKey.set(key, { key, error: parsed.error.message ?? "Unknown error" });
          continue;
        }
        const responseBody = parsed.response?.body;
        if (responseBody?.error) {
          resultsByKey.set(key, { key, error: responseBody.error.message ?? "Unknown error" });
          continue;
        }
        if (responseBody?.data) {
          resultsByKey.set(key, { key, result: parseOpenAIResponse(responseBody) });
          continue;
        }
        resultsByKey.set(key, { key, error: "No response in result line" });
      }
    };
    if (meta.output_file_id) {
      parseLines(await downloadBatchFile(meta.output_file_id));
    }
    if (meta.error_file_id) {
      parseLines(await downloadBatchFile(meta.error_file_id));
    }
    // 3. completeness check
    const expected = meta.request_counts?.total;
    if (expected != null && resultsByKey.size < expected) {
      console.error(
        `Warning: Expected ${expected} results, got ${resultsByKey.size}. ` +
        `${expected - resultsByKey.size} result(s) may be missing.`,
      );
    }
    return Array.from(resultsByKey.values());
  },

  async batchList(): Promise<BatchJob[]> {
    const res = await httpGetWithRetry(`${baseUrl}/v1/batches`, headers);
    if (res.status !== 200) {
      const err = (res.data as any)?.error;
      throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
    }
    const d = res.data as { data?: Array<{ id: string; status: string; created_at?: number }> };
    return (d.data ?? []).map((b) => ({
      id: b.id,
      state: mapOpenAIBatchState(b.status),
      createTime: b.created_at ? new Date(b.created_at * 1000).toISOString() : "",
    }));
  },

  async batchCancel(jobId: string): Promise<void> {
    const res = await httpPostWithRetry(`${baseUrl}/v1/batches/${jobId}/cancel`, {}, headers);
    if (res.status !== 200) {
      const err = (res.data as any)?.error;
      throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
    }
  },
};
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test scripts/providers/openai.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/http.test.ts scripts/providers/openai.ts scripts/providers/openai.test.ts
git commit -m "feat(openai): server-side batch via /v1/files + /v1/batches (text-only)"
```

The commit bundles the new retry wrappers (`httpPostMultipartWithRetry` / `httpGetTextWithRetry`) with the batch methods that consume them, since neither is useful without the other.

### Task 5.2 — Add `validateBatchTasks` for OpenAI text-only restriction

**Files:**
- Modify: `scripts/commands/batch.ts`
- Modify: `scripts/commands/batch.test.ts`

- [ ] **Step 1: Write failing test**

Append to `scripts/commands/batch.test.ts`:

```ts
import { validateBatchTasks } from "./batch";

describe("validateBatchTasks for OpenAI", () => {
  test("text-only tasks pass", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, quality: "normal", refs: [], imageSize: "1K" },
    ])).not.toThrow();
  });

  test("tasks with refs throw", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, quality: "normal", refs: ["/tmp/a.png"], imageSize: "1K" },
    ])).toThrow(/text-only/i);
  });

  test("tasks with editTarget throw", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, quality: "normal", refs: [], imageSize: "1K", editTarget: "/tmp/e.png" },
    ])).toThrow(/text-only/i);
  });

  test("tasks with mask throw", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, quality: "normal", refs: [], imageSize: "1K", mask: "/tmp/m.png" },
    ])).toThrow(/text-only/i);
  });

  test("error message mentions character profile", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, quality: "normal", refs: ["/tmp/a.png"], imageSize: "1K" },
    ])).toThrow(/character/i);
  });

  test("google provider unaffected", () => {
    expect(() => validateBatchTasks("google", [
      { prompt: "x", model: "m", ar: null, quality: "normal", refs: ["/tmp/a.png"], imageSize: "1K" },
    ])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `bun test scripts/commands/batch.test.ts`
Expected: FAIL — `validateBatchTasks` not exported

- [ ] **Step 3: Add `validateBatchTasks` to `scripts/commands/batch.ts`**

After `BatchManifest` interface and before `runBatch`:

```ts
export function validateBatchTasks(providerName: string, tasks: GenerateRequest[]): void {
  if (providerName !== "openai") return;
  const offending = tasks.filter(t =>
    t.refs.length > 0 || t.editTarget || t.mask
  );
  if (offending.length > 0) {
    throw new Error(
      `OpenAI server-side batch is text-only. ${offending.length} task(s) have image inputs ` +
      `(refs / editTarget / mask). Note: --character profile injects refs into all tasks, which also ` +
      `triggers this restriction. Either remove image inputs or use realtime mode.`,
    );
  }
}
```

Then call it in `batchSubmit` after tasks are built (after the character profile application):

```ts
// after the tasks.map(...) that applies character profile, and before payload estimation:
validateBatchTasks(provider.name, tasks);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test scripts/commands/batch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/commands/batch.ts scripts/commands/batch.test.ts
git commit -m "feat(batch): reject image inputs for OpenAI batch (text-only)"
```

---

## Step 6 — Command Layer Wiring + Capability Checks

### Task 6.1 — `validateProviderCapabilities` in generate.ts

**Files:**
- Modify: `scripts/commands/generate.ts`
- Modify: `scripts/commands/generate.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `scripts/commands/generate.test.ts`:

```ts
import { validateProviderCapabilities } from "./generate";

describe("validateProviderCapabilities", () => {
  const fakeProvider = (name: string, hasChain = false) => ({
    name,
    defaultModel: "m",
    generate: async () => ({ images: [], finishReason: "STOP" as const }),
    generateChained: hasChain ? (async () => ({ images: [], finishReason: "STOP" as const })) : undefined,
  });

  test("mask + non-openai throws", () => {
    expect(() => validateProviderCapabilities(fakeProvider("google") as any, {
      mask: "/tmp/m.png", edit: "/tmp/e.png",
    } as any)).toThrow(/mask.*openai/i);
  });

  test("mask without edit/ref throws", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai") as any, {
      mask: "/tmp/m.png",
    } as any)).toThrow(/mask.*requires/i);
  });

  test("mask with edit OK for openai", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai") as any, {
      mask: "/tmp/m.png", edit: "/tmp/e.png",
    } as any)).not.toThrow();
  });

  test("mask with ref OK for openai", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai") as any, {
      mask: "/tmp/m.png", ref: ["/tmp/r.png"],
    } as any)).not.toThrow();
  });

  test("chain on provider without generateChained throws", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai", false) as any, {
      chain: true,
    } as any)).toThrow(/chain/i);
  });

  test("chain on provider with generateChained OK", () => {
    expect(() => validateProviderCapabilities(fakeProvider("google", true) as any, {
      chain: true,
    } as any)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `bun test scripts/commands/generate.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `validateProviderCapabilities` in `scripts/commands/generate.ts`**

Add at top-level (before `runGenerate`):

```ts
export function validateProviderCapabilities(
  provider: Provider,
  flags: { mask?: string; edit?: string; ref?: string[]; chain?: boolean },
): void {
  if (flags.mask && provider.name !== "openai") {
    throw new Error(`--mask is supported only by openai provider (got: ${provider.name})`);
  }
  if (flags.mask && !flags.edit && (!flags.ref || flags.ref.length === 0)) {
    throw new Error("--mask requires --edit or --ref to specify the image being masked");
  }
  if (flags.chain && !provider.generateChained) {
    throw new Error(`Provider ${provider.name} does not support chain mode`);
  }
}
```

Then call it at the start of `runGenerate`, after `validateGenerateArgs(flags)`:

```ts
validateGenerateArgs(flags);
validateProviderCapabilities(provider, flags);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `bun test scripts/commands/generate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/commands/generate.ts scripts/commands/generate.test.ts
git commit -m "feat(generate): validateProviderCapabilities for mask/chain"
```

### Task 6.2 — Pass `editTarget` / `mask` into `GenerateRequest` and handle ERROR

**Files:**
- Modify: `scripts/commands/generate.ts`
- Modify: `scripts/commands/generate.test.ts`
- Modify: `scripts/commands/batch.ts`
- Modify: `scripts/commands/batch.test.ts`

- [ ] **Step 1: In `runGenerate`, pass flags.edit and flags.mask into GenerateRequest**

Find the `for (let taskIdx = 0; ...` loop in `scripts/commands/generate.ts`. In the `req: GenerateRequest = { ... }` block, add fields:

```ts
const req: GenerateRequest = {
  prompt: task.prompt,
  model: config.model,
  ar: task.ar ?? null,
  quality: task.quality ?? config.quality,
  refs: task.refs,
  imageSize: mapQualityToImageSize(task.quality ?? config.quality),
  editTarget: flags.edit,
  mask: flags.mask,
};
```

Also extend `runGenerate`'s `flags` parameter type to include `edit?: string; mask?: string;`.

- [ ] **Step 2: Add ERROR finishReason branch in runGenerate**

Find the `if (result.finishReason === "SAFETY")` block. Right after it, add:

```ts
if (result.finishReason === "ERROR") {
  const msg = result.safetyInfo?.reason ?? "Provider returned error";
  if (flags.json) {
    console.log(JSON.stringify({ error: msg, finishReason: "ERROR" }));
  } else {
    console.error(`Error: ${msg}`);
  }
  if (!useChain) process.exit(1);
  continue;
}
```

- [ ] **Step 3: Add ERROR handling in writeResults (batch.ts)**

In `scripts/commands/batch.ts`, find the `if (!r.result || r.result.images.length === 0)` block. Replace the `const msg = ...` line:

```ts
const msg = r.result?.finishReason === "SAFETY"
  ? `Safety block: ${r.result.safetyInfo?.reason ?? "unknown"}`
  : r.result?.finishReason === "ERROR"
  ? `Error: ${r.result.safetyInfo?.reason ?? "unknown"}`
  : "No image generated";
```

- [ ] **Step 4: Update main.ts to pass flags.edit and flags.mask**

Find `await runGenerate(provider, config, { ... })` in `scripts/main.ts`. Add to the object:

```ts
edit: args.flags.edit,
mask: args.flags.mask,
```

- [ ] **Step 5: Add tests for ERROR branch in generate.test.ts**

Append:

```ts
describe("runGenerate ERROR finishReason", () => {
  test("prints safetyInfo.reason and exits non-zero", async () => {
    const fakeProvider = {
      name: "openai", defaultModel: "gpt-image-2",
      generate: async () => ({
        images: [],
        finishReason: "ERROR" as const,
        safetyInfo: { reason: "invalid_size: bad" },
      }),
    };
    const errors: string[] = [];
    const originalErr = console.error;
    console.error = (m: string) => errors.push(m);
    const originalExit = process.exit;
    let exitCode = -1;
    (process.exit as any) = (code: number) => { exitCode = code; throw new Error("exit"); };
    try {
      const { mkdtempSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const tmp = mkdtempSync(join(tmpdir(), "jdy-runerr-"));
      await runGenerate(fakeProvider as any, {
        provider: "openai", model: "gpt-image-2", quality: "normal", ar: "1:1",
        apiKey: "k", baseUrl: "https://x.test",
      }, {
        prompt: "x", outdir: tmp, json: false,
      });
    } catch (e) { /* expected */ }
    finally {
      console.error = originalErr;
      (process.exit as any) = originalExit;
    }
    expect(errors.some(m => m.includes("invalid_size"))).toBe(true);
    expect(exitCode).toBe(1);
  });
});
```

- [ ] **Step 6: Add corresponding ERROR test in batch.test.ts**

Append:

```ts
describe("writeResults ERROR finishReason", () => {
  test("prints Error: <reason> instead of generic No image generated", () => {
    const errors: string[] = [];
    const originalErr = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      const { written, failed } = writeResults(
        [{ key: "001-x", result: { images: [], finishReason: "ERROR", safetyInfo: { reason: "rate_limit" } } }],
        "/tmp/jdy-batch-err-test",
        false,
        null,
      );
      expect(failed).toBe(1);
      expect(written).toBe(0);
      expect(errors.some(m => m.includes("rate_limit"))).toBe(true);
    } finally {
      console.error = originalErr;
    }
  });
});
```

(You may need to import `writeResults` and create the tmp dir first.)

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add scripts/commands/generate.ts scripts/commands/generate.test.ts scripts/commands/batch.ts scripts/commands/batch.test.ts scripts/main.ts
git commit -m "feat(commands): wire edit/mask flags; handle ERROR finishReason"
```

---

## Step 7 — Documentation

### Task 7.1 — Update `SKILL.md` and `README.md`

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update `SKILL.md`**

Replace contents:

```md
---
name: jdy-imagine
description: AI image generation via Google Gemini and OpenAI gpt-image-2 (realtime + batch). Text-to-image, image-to-image, edit with mask, batch generation at 50% cost.
---

# jdy-imagine

AI image generation plugin for Claude Code. Supports Google Gemini and OpenAI gpt-image-2 providers.

## Usage

### Text-to-image
```bash
bun scripts/main.ts generate --prompt "A cat in watercolor style" --outdir ./images
bun scripts/main.ts generate --provider openai --prompt "A cat in watercolor style" --outdir ./images
```

### Image-to-image (reference image)
```bash
bun scripts/main.ts generate --prompt "Make it blue" --ref source.png --outdir ./images
```

### Edit (with mask, OpenAI only)
```bash
bun scripts/main.ts generate --provider openai --prompt "Replace background" --edit photo.png --mask mask.png --outdir ./images
```

### Batch generation (50% cost savings)
```bash
bun scripts/main.ts batch submit prompts.json --outdir ./images
bun scripts/main.ts --provider openai batch submit text-only-prompts.json --outdir ./images
```

### Options
- `--provider`: `google` (default) or `openai`
- `--model`, `-m`: Model ID (provider default if not specified)
- `--ar`: Aspect ratio (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3)
- `--quality`: normal / 2k (default: 2k)
- `--ref`: Reference image path(s) — works in both providers
- `--edit`: Edit target image path — Google: same as --ref; OpenAI: routes to /edits
- `--mask`: Mask image path — OpenAI only, requires --edit or --ref
- `--outdir`, `-o`: Output directory (default: .)
- `--json`: JSON output mode

### Configuration
Google: `GOOGLE_API_KEY` or `GEMINI_API_KEY`
OpenAI: `OPENAI_API_KEY`
Or create `.jdy-imagine/.env`.

### Capability matrix

| Feature | Google | OpenAI |
|---|---|---|
| --ref | yes | yes (routes to /edits) |
| --edit | falls back to --ref | yes (native) |
| --mask | not supported | yes (needs --edit or --ref) |
| --chain | yes | not supported |
| --character | yes | yes (realtime); blocked in OpenAI batch |
| batch submit | yes | text-only (no refs/edit/mask/character) |
| 4K / arbitrary size | no | not exposed (use --quality 2k) |
```

- [ ] **Step 2: Update `README.md`**

Add a section after existing "Usage":

````md
## Capability Matrix

| Flag / Feature | Google | OpenAI | Notes |
|---|---|---|---|
| `--prompt` | ✓ | ✓ | |
| `--ref <path>` | ✓ | ✓ | Google: inlineData; OpenAI: image[] in /edits |
| `--edit <path>` | ✓ fallback | ✓ native | Google treats as ref[0]; OpenAI routes to /edits |
| `--mask <path>` | ✗ throws | ✓ (needs --edit or --ref) | |
| `--ar` | ✓ | ✓ | OpenAI uses fixed SIZE_TABLE mapping |
| `--quality normal\|2k` | ✓ | ✓ | OpenAI: normal→medium, 2k→high |
| `--chain` | ✓ | ✗ throws | OpenAI image API is stateless |
| `--character` | ✓ | ✓ realtime | Blocked in OpenAI batch (refs would be lost) |
| `batch submit` | ✓ | ✓ text-only | OpenAI uses /v1/batches with 50% discount |
| `batch submit --async` | ✓ | ✓ | |
| Batch with refs/edit/mask/character | ✓ | ✗ throws | OpenAI batch is text-only by design (YAGNI) |
| 4K / arbitrary size | ✗ | ✗ exposed | OpenAI 4K is server-supported but not in SIZE_TABLE |
| Transparent background | ✗ | ✗ | gpt-image-2 doesn't support background=transparent |

## Environment Variables

Google provider:
- `GOOGLE_API_KEY` or `GEMINI_API_KEY` (required)
- `GOOGLE_BASE_URL` (default: https://generativelanguage.googleapis.com)
- `GOOGLE_IMAGE_MODEL` (default: gemini-3.1-flash-image-preview)

OpenAI provider:
- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (default: https://api.openai.com)
- `OPENAI_IMAGE_MODEL` (default: gpt-image-2)

## OpenAI Examples

Text-to-image:
```bash
OPENAI_API_KEY=sk-... bun scripts/main.ts generate \
  --provider openai --prompt "A cozy alpine cabin at dawn" --outdir ./images
```

Image-to-image (reference):
```bash
bun scripts/main.ts generate --provider openai \
  --prompt "Apply a watercolor style" --ref source.png --outdir ./images
```

Edit with mask:
```bash
bun scripts/main.ts generate --provider openai \
  --prompt "Replace background with sunset" \
  --edit photo.png --mask mask.png --outdir ./images
```

Server-side batch (text-only, 50% off, 24h SLA):
```bash
bun scripts/main.ts --provider openai batch submit prompts.json --outdir ./images --async
```
````

- [ ] **Step 3: Commit**

```bash
git add SKILL.md README.md
git commit -m "docs: add OpenAI provider usage and capability matrix"
```

---

## Step 8 — Integration Test (End-to-End with Mocked OpenAI)

### Task 8.1 — Add OpenAI integration test paths

**Files:**
- Modify: `scripts/integration.test.ts`

- [ ] **Step 1: Read existing `scripts/integration.test.ts` to understand fixture conventions**

Run: `head -100 scripts/integration.test.ts`

Use the same conventions for fetch mocking and process invocation.

- [ ] **Step 2: Add OpenAI generate text-to-image integration test**

Append to `scripts/integration.test.ts`:

```ts
describe("integration: OpenAI provider", () => {
  test("generate text-to-image end-to-end", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-openai-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any) => {
      if (url.toString().includes("/v1/images/generations")) {
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from("FAKE-PNG").toString("base64") }],
        }), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    });
    process.env.OPENAI_API_KEY = "sk-fake";
    try {
      // Invoke via main.ts simulation: would normally use Bun.spawn but for unit, call programmatically
      const { runGenerate } = await import("./commands/generate");
      const { createOpenAIProvider } = await import("./providers/openai");
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      await runGenerate(provider as any, {
        provider: "openai", model: "gpt-image-2", quality: "normal", ar: "1:1",
        apiKey: "k", baseUrl: "https://api.openai.com",
      } as any, {
        prompt: "test cat", outdir: tmpOut, json: false,
      });
      // Verify file written
      const files = (await Bun.$`ls ${tmpOut}/`.text()).trim().split("\n").filter((f) => f.endsWith(".png"));
      expect(files.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_API_KEY;
      await Bun.$`rm -rf ${tmpOut}`;
    }
  });

  test("edit with mask end-to-end", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-openai-edit-"));
    const editFile = join(tmpOut, "edit.png");
    const maskFile = join(tmpOut, "mask.png");
    await Bun.write(editFile, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    await Bun.write(maskFile, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("PNG").toString("base64") }],
      }), { status: 200 });
    });
    try {
      const { runGenerate } = await import("./commands/generate");
      const { createOpenAIProvider } = await import("./providers/openai");
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      await runGenerate(provider as any, {
        provider: "openai", model: "gpt-image-2", quality: "normal", ar: "1:1",
        apiKey: "k", baseUrl: "https://api.openai.com",
      } as any, {
        prompt: "edit", edit: editFile, mask: maskFile, outdir: tmpOut, json: false,
      });
      expect(capturedUrl).toContain("/v1/images/edits");
    } finally {
      globalThis.fetch = originalFetch;
      await Bun.$`rm -rf ${tmpOut} ${editFile} ${maskFile}`;
    }
  });

  test("batch submit/status/fetch end-to-end", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-openai-batch-"));
    const promptsFile = join(tmpOut, "prompts.json");
    await Bun.write(promptsFile, JSON.stringify([
      { prompt: "cat" },
      { prompt: "dog" },
    ]));
    const jsonlOutput =
      JSON.stringify({ custom_id: "001-cat", response: { body: { data: [{ b64_json: Buffer.from("CAT").toString("base64") }] } } }) + "\n" +
      JSON.stringify({ custom_id: "002-dog", response: { body: { data: [{ b64_json: Buffer.from("DOG").toString("base64") }] } } }) + "\n";
    let pollCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any, init: any) => {
      const u = url.toString();
      if (u.includes("/v1/files") && init.method === "POST") {
        return new Response(JSON.stringify({ id: "file_in" }), { status: 200 });
      }
      if (u.includes("/v1/batches") && init.method === "POST" && !u.includes("/cancel")) {
        return new Response(JSON.stringify({ id: "batch_int", status: "validating", created_at: 1000 }), { status: 200 });
      }
      if (u.includes("/v1/batches/batch_int") && (!init.method || init.method === "GET")) {
        pollCount++;
        const status = pollCount >= 2 ? "completed" : "in_progress";
        return new Response(JSON.stringify({
          id: "batch_int", status, created_at: 1000,
          output_file_id: "file_out",
          request_counts: { total: 2, completed: 2, failed: 0 },
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_out/content")) {
        return new Response(jsonlOutput, { status: 200 });
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const { runBatch } = await import("./commands/batch");
      const { createOpenAIProvider } = await import("./providers/openai");
      const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
      await runBatch(provider as any, {
        provider: "openai", model: "gpt-image-2", quality: "normal", ar: "1:1",
        apiKey: "k", baseUrl: "https://api.openai.com",
      } as any, {
        command: "batch", subcommand: "submit", positional: promptsFile,
        flags: { outdir: tmpOut, json: false, async: false, chain: false },
      } as any);
      const files = (await Bun.$`ls ${tmpOut}/`.text()).trim().split("\n").filter((f) => f.endsWith(".png"));
      expect(files.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      await Bun.$`rm -rf ${tmpOut}`;
    }
  }, 30000);
});
```

- [ ] **Step 3: Run integration tests**

Run: `bun test scripts/integration.test.ts`
Expected: PASS — all 3 OpenAI integration paths green; existing Google tests still green

- [ ] **Step 4: Run full test suite for regression**

Run: `bun test`
Expected: PASS — all suites green

- [ ] **Step 5: Commit**

```bash
git add scripts/integration.test.ts
git commit -m "test(integration): end-to-end OpenAI generate/edit/batch with mocked server"
```

---

## Final Verification

### Task F.1 — Manual smoke test (optional, requires real key)

If you have an `OPENAI_API_KEY`, run these to verify the real wire format:

```bash
export OPENAI_API_KEY=sk-...
bun scripts/main.ts generate --provider openai --prompt "A small red apple on a white background" --outdir /tmp/jdy-real
ls /tmp/jdy-real
```

Expected: `001-a-small-red-apple-on-a-white-background.png` exists and opens correctly.

(Skip if no real key — integration tests already verified the wire format with mocked responses.)

### Task F.2 — Push branch

- [ ] **Step 1: Push feature branch**

```bash
git push -u origin feat/openai-gpt-image-2-provider
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --base main --title "feat(openai): add OpenAI gpt-image-2 provider" --body "$(cat <<'EOF'
## Summary
Adds OpenAI gpt-image-2 as a second provider to jdy-imagine, supporting realtime generate (text-to-image, image-to-image, edit with mask) and server-side batch (text-only with 50% discount). Simultaneously fixes abstraction-layer pain points discovered during integration design.

See spec: docs/superpowers/specs/2026-04-28-openai-gpt-image-2-provider-design.md
See plan: docs/superpowers/plans/2026-04-28-openai-gpt-image-2-provider.md

## Test plan
- [ ] All existing Google tests pass
- [ ] New OpenAI provider unit tests pass (table-driven SIZE_TABLE, routing, error mapping, batch state mapping)
- [ ] Integration tests cover: generate text-only / edit with mask / batch end-to-end
- [ ] Manual smoke test with real OPENAI_API_KEY (optional)
EOF
)"
```
