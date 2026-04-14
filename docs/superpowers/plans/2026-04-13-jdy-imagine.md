# jdy-imagine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin for AI image generation with Google Gemini support (realtime + batch), zero npm dependencies, TypeScript + Bun.

**Architecture:** Provider-extensible CLI with subcommand routing (`generate` for realtime, `batch` for async). Google provider implements the `Provider` interface using Gemini's `generateContent` and `batchGenerateContent` endpoints. Lib layer handles arg parsing, config loading, HTTP transport (fetch + curl proxy fallback), and output naming/writing.

**Tech Stack:** TypeScript, Bun (runtime + test runner + bundler), zero npm dependencies

---

## File Map

| File | Responsibility | Created in |
|------|---------------|------------|
| `scripts/providers/types.ts` | Provider interface + shared types | Task 1 |
| `scripts/lib/output.ts` | Slug generation, file naming, image writing | Task 2 |
| `scripts/lib/config.ts` | .env loading, EXTEND.md parsing, config merge | Task 3 |
| `scripts/lib/http.ts` | HTTP client (fetch + curl proxy fallback) | Task 4 |
| `scripts/lib/args.ts` | CLI arg parsing | Task 5 |
| `scripts/providers/google.ts` | Google provider (realtime + batch) | Task 6, 9 |
| `scripts/commands/generate.ts` | Realtime generation command | Task 7 |
| `scripts/main.ts` | Entry point, subcommand router | Task 8 |
| `scripts/commands/batch.ts` | Batch submit/status/fetch/list/cancel | Task 10 |
| `.claude-plugin/marketplace.json` | Plugin metadata | Task 11 |
| `SKILL.md` | Skill documentation | Task 11 |
| `EXTEND.md.example` | Config template | Task 11 |

Tests live alongside source: `scripts/**/*.test.ts` using Bun's built-in test runner.

---

### Task 1: Provider Types

**Files:**
- Create: `scripts/providers/types.ts`
- Test: `scripts/providers/types.test.ts`

- [ ] **Step 1: Write type validation test**

```typescript
// scripts/providers/types.test.ts
import { describe, test, expect } from "bun:test";
import type {
  GenerateRequest,
  GenerateResult,
  BatchCreateRequest,
  BatchJob,
  BatchResult,
  Provider,
} from "./types";

describe("Provider types", () => {
  test("GenerateRequest has required fields", () => {
    const req: GenerateRequest = {
      prompt: "A cat",
      model: "gemini-3.1-flash-image-preview",
      ar: "16:9",
      quality: "2k",
      refs: [],
      imageSize: "2K",
    };
    expect(req.prompt).toBe("A cat");
    expect(req.refs).toEqual([]);
  });

  test("GenerateResult supports multi-image and safety", () => {
    const result: GenerateResult = {
      images: [
        { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      ],
      finishReason: "STOP",
    };
    expect(result.images).toHaveLength(1);
    expect(result.finishReason).toBe("STOP");

    const blocked: GenerateResult = {
      images: [],
      finishReason: "SAFETY",
      safetyInfo: { category: "HARM_CATEGORY_DANGEROUS", reason: "Content blocked" },
    };
    expect(blocked.images).toHaveLength(0);
    expect(blocked.safetyInfo?.category).toBe("HARM_CATEGORY_DANGEROUS");
  });

  test("BatchResult references GenerateResult", () => {
    const br: BatchResult = {
      key: "001-cat",
      result: {
        images: [{ data: new Uint8Array([1]), mimeType: "image/png" }],
        finishReason: "STOP",
      },
    };
    expect(br.result?.images).toHaveLength(1);

    const errBr: BatchResult = {
      key: "002-fail",
      error: "Content blocked",
    };
    expect(errBr.error).toBe("Content blocked");
  });

  test("BatchJob has state enum", () => {
    const job: BatchJob = {
      id: "batches/abc123",
      state: "succeeded",
      createTime: "2026-04-13T10:00:00Z",
      stats: { total: 2, succeeded: 2, failed: 0 },
    };
    expect(job.state).toBe("succeeded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/providers/types.test.ts`
Expected: FAIL — cannot resolve `./types`

- [ ] **Step 3: Write the types**

```typescript
// scripts/providers/types.ts

export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;
  quality: "normal" | "2k";
  refs: string[]; // local file paths
  imageSize: "1K" | "2K" | "4K";
}

export interface GenerateResult {
  images: Array<{
    data: Uint8Array;
    mimeType: string; // "image/png" | "image/jpeg"
  }>;
  finishReason: "STOP" | "SAFETY" | "MAX_TOKENS" | "OTHER";
  safetyInfo?: {
    category: string;
    reason: string;
  };
  textParts?: string[]; // any text returned alongside images
}

export interface BatchCreateRequest {
  model: string;
  tasks: GenerateRequest[];
  displayName?: string;
}

export interface BatchJob {
  id: string; // e.g. "batches/abc123"
  state:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";
  createTime: string;
  stats?: { total: number; succeeded: number; failed: number };
}

export interface BatchResult {
  key: string;
  result?: GenerateResult; // same structure as realtime
  error?: string;
}

export interface Provider {
  name: string;
  defaultModel: string;

  // Realtime
  generate(req: GenerateRequest): Promise<GenerateResult>;

  // Batch (optional)
  batchCreate?(req: BatchCreateRequest): Promise<BatchJob>;
  batchGet?(jobId: string): Promise<BatchJob>;
  batchFetch?(jobId: string): Promise<BatchResult[]>;
  batchList?(): Promise<BatchJob[]>;
  batchCancel?(jobId: string): Promise<void>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/providers/types.test.ts`
Expected: PASS — all type checks compile and assertions pass

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/types.ts scripts/providers/types.test.ts
git commit -m "feat(types): add provider interface and shared types"
```

---

### Task 2: Output Naming & File Writing

**Files:**
- Create: `scripts/lib/output.ts`
- Test: `scripts/lib/output.test.ts`

- [ ] **Step 1: Write slug generation tests**

```typescript
// scripts/lib/output.test.ts
import { describe, test, expect } from "bun:test";
import { generateSlug, buildOutputPath, mimeToExt } from "./output";

describe("mimeToExt", () => {
  test("image/png → .png", () => {
    expect(mimeToExt("image/png")).toBe(".png");
  });

  test("image/jpeg → .jpg", () => {
    expect(mimeToExt("image/jpeg")).toBe(".jpg");
  });
});

describe("generateSlug", () => {
  test("English prompt → lowercase hyphenated first 4 words", () => {
    expect(generateSlug("A sunset over mountains")).toBe("a-sunset-over-mountains");
  });

  test("CJK prompt → kept as-is, first 4 tokens", () => {
    expect(generateSlug("一只可爱的猫在花园里")).toBe("一只可爱的猫在花园里");
  });

  test("long prompt → truncated to 40 chars", () => {
    const slug = generateSlug("Create a very detailed and elaborate architectural blueprint design");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  test("emoji prompt → stripped, fallback if empty", () => {
    expect(generateSlug("🎉🎊🎈")).toBe("img");
  });

  test("mixed content → emoji stripped, words kept", () => {
    const slug = generateSlug("Hello 🌍 world");
    expect(slug).toBe("hello-world");
  });

  test("OS-reserved characters stripped", () => {
    const slug = generateSlug('file: "test" <name>');
    expect(slug).not.toMatch(/[<>:"/\\|?*]/);
  });

  test("trailing dash and dot stripped", () => {
    const slug = generateSlug("test-");
    expect(slug).not.toMatch(/[-.]$/);
  });
});

describe("buildOutputPath", () => {
  test("generates NNN-slug.png pattern", () => {
    const path = buildOutputPath("/tmp/out", "a-sunset", 1);
    expect(path).toBe("/tmp/out/001-a-sunset.png");
  });

  test("zero-pads sequence number", () => {
    const path = buildOutputPath("/tmp/out", "cat", 42);
    expect(path).toBe("/tmp/out/042-cat.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/output.test.ts`
Expected: FAIL — cannot resolve `./output`

- [ ] **Step 3: Implement slug generation and output path building**

```typescript
// scripts/lib/output.ts
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// Unicode emoji regex (covers most emoji ranges)
const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;

// OS-reserved characters + ASCII control chars
const RESERVED_RE = /[<>:"/\\|?*\x00-\x1F]/g;

// Zero-width characters
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

export function generateSlug(prompt: string): string {
  // 1. Unicode NFC normalization
  let text = prompt.normalize("NFC");

  // 2. Strip emoji, zero-width, control characters
  text = text.replace(EMOJI_RE, "").replace(ZERO_WIDTH_RE, "");

  // 3. Extract words (split on whitespace and punctuation)
  const words = text
    .split(/[\s\p{P}]+/u)
    .filter((w) => w.length > 0);

  // 4. Take first 4 tokens
  const tokens = words.slice(0, 4);

  // 5. Lowercase, join with -
  let slug = tokens.map((t) => t.toLowerCase()).join("-");

  // 6. Remove OS-reserved characters
  slug = slug.replace(RESERVED_RE, "");

  // 7. Truncate to 40 characters
  slug = slug.slice(0, 40);

  // 8. Strip trailing - and .
  slug = slug.replace(/[-.]+$/, "");

  // 9. Fallback if empty
  if (!slug) slug = "img";

  return slug;
}

export function mimeToExt(mimeType: string): string {
  return mimeType === "image/jpeg" ? ".jpg" : ".png";
}

export function buildOutputPath(
  outdir: string,
  slug: string,
  seq: number,
  ext: string = ".png",
): string {
  const pad = String(seq).padStart(3, "0");
  return join(outdir, `${pad}-${slug}${ext}`);
}

export function resolveOutputPath(
  outdir: string,
  slug: string,
  seq: number,
  ext: string = ".png",
): string {
  let path = buildOutputPath(outdir, slug, seq, ext);
  let suffix = 2;
  while (existsSync(path)) {
    const pad = String(seq).padStart(3, "0");
    path = join(outdir, `${pad}-${slug}-${suffix}${ext}`);
    suffix++;
  }
  return path;
}

export function ensureOutdir(outdir: string): void {
  if (!existsSync(outdir)) {
    mkdirSync(outdir, { recursive: true });
  }
}

export function writeImage(path: string, data: Uint8Array): void {
  writeFileSync(path, data);
}

export function nextSeqNumber(outdir: string): number {
  if (!existsSync(outdir)) return 1;
  let max = 0;
  for (const ext of ["*.png", "*.jpg"]) {
    const files = Bun.glob(ext).scanSync({ cwd: outdir });
    for (const f of files) {
      const match = f.match(/^(\d+)-/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > max) max = n;
      }
    }
  }
  return max + 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/output.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/output.ts scripts/lib/output.test.ts
git commit -m "feat(output): add slug generation and output path utilities"
```

---

### Task 3: Config Loading

**Files:**
- Create: `scripts/lib/config.ts`
- Test: `scripts/lib/config.test.ts`
- Create: `EXTEND.md.example`

- [ ] **Step 1: Write config tests**

```typescript
// scripts/lib/config.test.ts
import { describe, test, expect } from "bun:test";
import { parseExtendMd, parseDotEnv, mergeConfig, type Config } from "./config";

describe("parseExtendMd", () => {
  test("parses YAML front matter", () => {
    const content = `---
default_provider: google
default_model: gemini-3.1-flash-image-preview
default_quality: 2k
default_ar: "1:1"
---`;
    const result = parseExtendMd(content);
    expect(result.default_provider).toBe("google");
    expect(result.default_model).toBe("gemini-3.1-flash-image-preview");
    expect(result.default_quality).toBe("2k");
    expect(result.default_ar).toBe("1:1");
  });

  test("returns empty object for no front matter", () => {
    expect(parseExtendMd("just text")).toEqual({});
  });

  test("returns empty object for empty input", () => {
    expect(parseExtendMd("")).toEqual({});
  });
});

describe("parseDotEnv", () => {
  test("parses KEY=VALUE lines", () => {
    const content = `GOOGLE_API_KEY=abc123
GEMINI_API_KEY=def456
# comment
EMPTY=`;
    const result = parseDotEnv(content);
    expect(result.GOOGLE_API_KEY).toBe("abc123");
    expect(result.GEMINI_API_KEY).toBe("def456");
    expect(result.EMPTY).toBe("");
  });

  test("ignores comments and blank lines", () => {
    const result = parseDotEnv("# comment\n\nKEY=val");
    expect(Object.keys(result)).toEqual(["KEY"]);
  });
});

describe("mergeConfig", () => {
  test("CLI flags override everything", () => {
    const config = mergeConfig(
      { model: "cli-model" },      // CLI flags
      { default_model: "ext-model" }, // EXTEND.md
      { GOOGLE_IMAGE_MODEL: "env-model" }, // env
    );
    expect(config.model).toBe("cli-model");
  });

  test("EXTEND.md overrides env", () => {
    const config = mergeConfig(
      {},
      { default_model: "ext-model" },
      { GOOGLE_IMAGE_MODEL: "env-model" },
    );
    expect(config.model).toBe("ext-model");
  });

  test("env overrides defaults", () => {
    const config = mergeConfig(
      {},
      {},
      { GOOGLE_IMAGE_MODEL: "env-model" },
    );
    expect(config.model).toBe("env-model");
  });

  test("built-in defaults used when nothing set", () => {
    const config = mergeConfig({}, {}, {});
    expect(config.model).toBe("gemini-3.1-flash-image-preview");
    expect(config.provider).toBe("google");
    expect(config.quality).toBe("2k");
    expect(config.ar).toBe("1:1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/config.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement config loading**

```typescript
// scripts/lib/config.ts

export interface Config {
  provider: string;
  model: string;
  quality: "normal" | "2k";
  ar: string;
  apiKey: string;
  baseUrl: string;
}

const DEFAULTS: Config = {
  provider: "google",
  model: "gemini-3.1-flash-image-preview",
  quality: "2k",
  ar: "1:1",
  apiKey: "",
  baseUrl: "https://generativelanguage.googleapis.com",
};

export function parseExtendMd(
  content: string,
): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

export function mergeConfig(
  cliFlags: Record<string, string | undefined>,
  extendMd: Record<string, string>,
  env: Record<string, string | undefined>,
): Config {
  return {
    provider:
      cliFlags.provider ??
      extendMd.default_provider ??
      DEFAULTS.provider,
    model:
      cliFlags.model ??
      extendMd.default_model ??
      env.GOOGLE_IMAGE_MODEL ??
      DEFAULTS.model,
    quality: (cliFlags.quality ??
      extendMd.default_quality ??
      DEFAULTS.quality) as "normal" | "2k",
    ar:
      cliFlags.ar ??
      extendMd.default_ar ??
      DEFAULTS.ar,
    apiKey:
      env.GOOGLE_API_KEY ??
      env.GEMINI_API_KEY ??
      DEFAULTS.apiKey,
    baseUrl:
      env.GOOGLE_BASE_URL ??
      DEFAULTS.baseUrl,
  };
}

export function loadDotEnvFile(): Record<string, string> {
  const { existsSync, readFileSync } = require("fs");
  const { join } = require("path");
  const paths = [
    join(process.cwd(), ".jdy-imagine", ".env"),
    join(process.env.HOME ?? "", ".jdy-imagine", ".env"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return parseDotEnv(readFileSync(p, "utf-8"));
    }
  }
  return {};
}

export function loadExtendMd(): Record<string, string> {
  const { existsSync, readFileSync } = require("fs");
  const { join } = require("path");
  const paths = [
    join(process.cwd(), ".jdy-imagine", "EXTEND.md"),
    join(process.env.HOME ?? "", ".config", "jdy-imagine", "EXTEND.md"),
    join(process.env.HOME ?? "", ".jdy-imagine", "EXTEND.md"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return parseExtendMd(readFileSync(p, "utf-8"));
    }
  }
  return {};
}

export function resolveConfig(
  cliFlags: Record<string, string | undefined>,
): Config {
  const dotEnv = loadDotEnvFile();
  // Load .env vars into process.env (only if not already set)
  for (const [k, v] of Object.entries(dotEnv)) {
    if (!(k in process.env)) {
      process.env[k] = v;
    }
  }
  const extendMd = loadExtendMd();
  return mergeConfig(cliFlags, extendMd, process.env as Record<string, string>);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/config.test.ts`
Expected: PASS

- [ ] **Step 5: Create EXTEND.md.example**

```yaml
# EXTEND.md.example
---
default_provider: google
default_model: gemini-3.1-flash-image-preview
default_quality: 2k
default_ar: "1:1"
---
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/config.ts scripts/lib/config.test.ts EXTEND.md.example
git commit -m "feat(config): add config loading with EXTEND.md and .env support"
```

---

### Task 4: HTTP Client

**Files:**
- Create: `scripts/lib/http.ts`
- Test: `scripts/lib/http.test.ts`

- [ ] **Step 1: Write HTTP client tests**

```typescript
// scripts/lib/http.test.ts
import { describe, test, expect, mock } from "bun:test";
import { detectProxy, buildHeaders } from "./http";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/http.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement HTTP client**

```typescript
// scripts/lib/http.ts
import { execFileSync } from "child_process";

const CONNECT_TIMEOUT = 30_000;
const TOTAL_TIMEOUT = 300_000;

export function detectProxy(
  env: Record<string, string | undefined>,
): string | null {
  return env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? null;
}

export function buildHeaders(
  apiKey: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

export interface HttpResponse {
  status: number;
  data: unknown;
}

export async function httpPost(
  url: string,
  body: unknown,
  apiKey: string,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlPost(url, body, apiKey, proxy);
  }
  return fetchPost(url, body, apiKey);
}

async function fetchPost(
  url: string,
  body: unknown,
  apiKey: string,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function curlPost(
  url: string,
  body: unknown,
  apiKey: string,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout",
    String(CONNECT_TIMEOUT / 1000),
    "--max-time",
    String(TOTAL_TIMEOUT / 1000),
    "-x",
    proxy,
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "-H",
    `x-goog-api-key: ${apiKey}`,
    "-d",
    JSON.stringify(body),
    "-w",
    "\n%{http_code}",
    url,
  ];
  const output = execFileSync("curl", args, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const lines = output.trimEnd().split("\n");
  const statusCode = parseInt(lines.pop()!, 10);
  const data = JSON.parse(lines.join("\n"));
  return { status: statusCode, data };
}

const RETRY_DELAYS_HTTP = [1000, 2000, 4000];
const RETRYABLE_HTTP = new Set([429, 500, 503]);

async function withRetry(
  fn: () => Promise<HttpResponse>,
): Promise<HttpResponse> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    const res = await fn();
    if (!RETRYABLE_HTTP.has(res.status) || attempt === RETRY_DELAYS_HTTP.length) {
      return res;
    }
    await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
  }
  throw new Error("Unreachable");
}

export async function httpPostWithRetry(
  url: string,
  body: unknown,
  apiKey: string,
): Promise<HttpResponse> {
  return withRetry(() => httpPost(url, body, apiKey));
}

export async function httpGetWithRetry(
  url: string,
  apiKey: string,
): Promise<HttpResponse> {
  return withRetry(() => httpGet(url, apiKey));
}

export async function httpGet(
  url: string,
  apiKey: string,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlGet(url, apiKey, proxy);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: buildHeaders(apiKey),
      signal: controller.signal,
    });
    const data = await res.json();
    return { status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function curlGet(
  url: string,
  apiKey: string,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout",
    String(CONNECT_TIMEOUT / 1000),
    "--max-time",
    String(TOTAL_TIMEOUT / 1000),
    "-x",
    proxy,
    "-H",
    `x-goog-api-key: ${apiKey}`,
    "-w",
    "\n%{http_code}",
    url,
  ];
  const output = execFileSync("curl", args, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const lines = output.trimEnd().split("\n");
  const statusCode = parseInt(lines.pop()!, 10);
  const data = JSON.parse(lines.join("\n"));
  return { status: statusCode, data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/http.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/http.test.ts
git commit -m "feat(http): add HTTP client with fetch and curl proxy fallback"
```

---

### Task 5: CLI Arg Parsing

**Files:**
- Create: `scripts/lib/args.ts`
- Test: `scripts/lib/args.test.ts`

- [ ] **Step 1: Write arg parsing tests**

```typescript
// scripts/lib/args.test.ts
import { describe, test, expect } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  test("parses generate command with all flags", () => {
    const result = parseArgs([
      "generate",
      "--prompt", "A cat",
      "--outdir", "./images",
      "--ar", "16:9",
      "--quality", "2k",
      "--model", "gemini-3-pro-image-preview",
      "--ref", "source.png",
    ]);
    expect(result.command).toBe("generate");
    expect(result.flags.prompt).toBe("A cat");
    expect(result.flags.outdir).toBe("./images");
    expect(result.flags.ar).toBe("16:9");
    expect(result.flags.quality).toBe("2k");
    expect(result.flags.model).toBe("gemini-3-pro-image-preview");
    expect(result.flags.ref).toEqual(["source.png"]);
  });

  test("parses -m alias for --model", () => {
    const result = parseArgs(["generate", "-m", "test-model", "--prompt", "x"]);
    expect(result.flags.model).toBe("test-model");
  });

  test("parses -o alias for --outdir", () => {
    const result = parseArgs(["generate", "-o", "./out", "--prompt", "x"]);
    expect(result.flags.outdir).toBe("./out");
  });

  test("parses batch submit command", () => {
    const result = parseArgs([
      "batch", "submit", "prompts.json",
      "--outdir", "./images",
      "--async",
    ]);
    expect(result.command).toBe("batch");
    expect(result.subcommand).toBe("submit");
    expect(result.positional).toBe("prompts.json");
    expect(result.flags.async).toBe(true);
  });

  test("parses batch status command", () => {
    const result = parseArgs(["batch", "status", "batches/abc123"]);
    expect(result.command).toBe("batch");
    expect(result.subcommand).toBe("status");
    expect(result.positional).toBe("batches/abc123");
  });

  test("parses --json flag", () => {
    const result = parseArgs(["generate", "--prompt", "x", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  test("parses --prompts for multi-prompt mode", () => {
    const result = parseArgs(["generate", "--prompts", "prompts.json"]);
    expect(result.flags.prompts).toBe("prompts.json");
  });

  test("parses multiple --ref flags", () => {
    const result = parseArgs([
      "generate", "--prompt", "x",
      "--ref", "a.png", "--ref", "b.png",
    ]);
    expect(result.flags.ref).toEqual(["a.png", "b.png"]);
  });

  test("defaults outdir to .", () => {
    const result = parseArgs(["generate", "--prompt", "x"]);
    expect(result.flags.outdir).toBe(".");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/args.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement arg parsing**

```typescript
// scripts/lib/args.ts

export interface ParsedArgs {
  command: string; // "generate" | "batch"
  subcommand?: string; // "submit" | "status" | "fetch" | "list" | "cancel"
  positional?: string; // file path or job ID
  flags: {
    prompt?: string;
    prompts?: string;
    model?: string;
    provider?: string;
    ar?: string;
    quality?: string;
    ref?: string[];
    outdir: string;
    json: boolean;
    async: boolean;
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "",
    flags: {
      outdir: ".",
      json: false,
      async: false,
    },
  };

  let i = 0;

  // First arg is command
  if (i < argv.length && !argv[i].startsWith("-")) {
    result.command = argv[i++];
  }

  // For batch command, next non-flag is subcommand
  if (result.command === "batch" && i < argv.length && !argv[i].startsWith("-")) {
    result.subcommand = argv[i++];
  }

  // For batch subcommands, next non-flag is positional (file or jobId)
  if (
    result.command === "batch" &&
    result.subcommand &&
    result.subcommand !== "list" &&
    i < argv.length &&
    !argv[i].startsWith("-")
  ) {
    result.positional = argv[i++];
  }

  // Parse remaining flags
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--prompt":
        result.flags.prompt = argv[++i];
        break;
      case "--prompts":
        result.flags.prompts = argv[++i];
        break;
      case "--model":
      case "-m":
        result.flags.model = argv[++i];
        break;
      case "--provider":
        result.flags.provider = argv[++i];
        break;
      case "--ar":
        result.flags.ar = argv[++i];
        break;
      case "--quality":
        result.flags.quality = argv[++i];
        break;
      case "--ref":
        if (!result.flags.ref) result.flags.ref = [];
        result.flags.ref.push(argv[++i]);
        break;
      case "--outdir":
      case "-o":
        result.flags.outdir = argv[++i];
        break;
      case "--json":
        result.flags.json = true;
        break;
      case "--async":
        result.flags.async = true;
        break;
      default:
        // Unknown flag — skip
        break;
    }
    i++;
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/lib/args.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/args.ts scripts/lib/args.test.ts
git commit -m "feat(args): add CLI arg parsing with aliases and multi-ref support"
```

---

### Task 6: Google Provider — Realtime

**Files:**
- Create: `scripts/providers/google.ts`
- Test: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write tests for request building and response parsing**

```typescript
// scripts/providers/google.test.ts
import { describe, test, expect } from "bun:test";
import {
  buildRealtimeRequestBody,
  parseGenerateResponse,
  mapQualityToImageSize,
} from "./google";

describe("mapQualityToImageSize", () => {
  test("normal → 1K", () => {
    expect(mapQualityToImageSize("normal")).toBe("1K");
  });

  test("2k → 2K", () => {
    expect(mapQualityToImageSize("2k")).toBe("2K");
  });
});

describe("buildRealtimeRequestBody", () => {
  test("text-only prompt without refs", () => {
    const body = buildRealtimeRequestBody({
      prompt: "A cat",
      model: "gemini-3.1-flash-image-preview",
      ar: "16:9",
      quality: "2k",
      refs: [],
      imageSize: "2K",
    });
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts).toHaveLength(1);
    expect(body.contents[0].parts[0].text).toContain("A cat");
    expect(body.contents[0].parts[0].text).toContain("Aspect ratio: 16:9");
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
    expect(body.generationConfig.imageConfig.imageSize).toBe("2K");
  });

  test("prompt with ref images", () => {
    // Mock: we pass base64 encoded refs
    const body = buildRealtimeRequestBody({
      prompt: "Make it blue",
      model: "gemini-3.1-flash-image-preview",
      ar: null,
      quality: "normal",
      refs: [], // refs are loaded externally; we test the structure
      imageSize: "1K",
    });
    expect(body.contents[0].parts[0].text).toBe("Make it blue");
  });

  test("no aspect ratio → no AR in prompt text", () => {
    const body = buildRealtimeRequestBody({
      prompt: "A cat",
      model: "test",
      ar: null,
      quality: "2k",
      refs: [],
      imageSize: "2K",
    });
    expect(body.contents[0].parts[0].text).not.toContain("Aspect ratio");
  });
});

describe("parseGenerateResponse", () => {
  test("parses successful single image response", () => {
    const apiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from("fake-image").toString("base64"),
                  mimeType: "image/png",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.finishReason).toBe("STOP");
  });

  test("parses safety-blocked response", () => {
    const apiResponse = {
      candidates: [
        {
          content: { parts: [] },
          finishReason: "SAFETY",
          safetyRatings: [
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              probability: "HIGH",
            },
          ],
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(0);
    expect(result.finishReason).toBe("SAFETY");
    expect(result.safetyInfo).toBeDefined();
  });

  test("parses multi-image response", () => {
    const apiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from("img1").toString("base64"),
                  mimeType: "image/png",
                },
              },
              { text: "Here are the images" },
              {
                inlineData: {
                  data: Buffer.from("img2").toString("base64"),
                  mimeType: "image/jpeg",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(2);
    expect(result.textParts).toEqual(["Here are the images"]);
  });

  test("parses text-only response (no images)", () => {
    const apiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "I cannot generate that image" }],
          },
          finishReason: "STOP",
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(0);
    expect(result.finishReason).toBe("STOP");
    expect(result.textParts).toEqual(["I cannot generate that image"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/providers/google.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement request building and response parsing**

```typescript
// scripts/providers/google.ts
import { readFileSync } from "fs";
import { httpPost, httpGet, httpPostWithRetry, httpGetWithRetry } from "../lib/http";
import type {
  GenerateRequest,
  GenerateResult,
  BatchCreateRequest,
  BatchJob,
  BatchResult,
  Provider,
} from "./types";

export function mapQualityToImageSize(
  quality: "normal" | "2k",
): "1K" | "2K" {
  return quality === "normal" ? "1K" : "2K";
}

export function buildRealtimeRequestBody(req: GenerateRequest): {
  contents: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  generationConfig: {
    responseModalities: string[];
    imageConfig: { imageSize: string };
  };
} {
  const parts: Array<Record<string, unknown>> = [];

  // Add ref images as inlineData parts
  for (const refPath of req.refs) {
    const data = readFileSync(refPath);
    const ext = refPath.split(".").pop()?.toLowerCase();
    const mimeType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    parts.push({
      inlineData: {
        data: Buffer.from(data).toString("base64"),
        mimeType,
      },
    });
  }

  // Build prompt text with aspect ratio appended
  let promptText = req.prompt;
  if (req.ar) {
    promptText += `. Aspect ratio: ${req.ar}.`;
  }
  parts.push({ text: promptText });

  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { imageSize: req.imageSize },
    },
  };
}

export function parseGenerateResponse(apiResponse: {
  candidates?: Array<{
    content?: { parts?: Array<Record<string, unknown>> };
    finishReason?: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
}): GenerateResult {
  const candidate = apiResponse.candidates?.[0];
  const finishReason = (candidate?.finishReason ?? "OTHER") as
    | "STOP"
    | "SAFETY"
    | "MAX_TOKENS"
    | "OTHER";

  const result: GenerateResult = {
    images: [],
    finishReason,
  };

  // Handle safety block
  if (finishReason === "SAFETY") {
    const rating = candidate?.safetyRatings?.[0];
    if (rating) {
      result.safetyInfo = {
        category: rating.category,
        reason: `Blocked: ${rating.category} (${rating.probability})`,
      };
    }
    return result;
  }

  // Parse parts
  const parts = candidate?.content?.parts ?? [];
  const textParts: string[] = [];

  for (const part of parts) {
    if (part.inlineData) {
      const inline = part.inlineData as {
        data: string;
        mimeType: string;
      };
      result.images.push({
        data: Buffer.from(inline.data, "base64"),
        mimeType: inline.mimeType,
      });
    } else if (typeof part.text === "string") {
      textParts.push(part.text);
    }
  }

  if (textParts.length > 0) {
    result.textParts = textParts;
  }

  return result;
}

const RETRY_DELAYS = [1000, 2000, 4000];
const RETRYABLE_STATUS = new Set([429, 500, 503]);

export function createGoogleProvider(
  apiKey: string,
  baseUrl: string,
): Provider {
  async function generateWithRetry(
    req: GenerateRequest,
  ): Promise<GenerateResult> {
    const url = `${baseUrl}/v1beta/models/${req.model}:generateContent`;
    const body = buildRealtimeRequestBody(req);

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await httpPost(url, body, apiKey);

      if (res.status === 200) {
        return parseGenerateResponse(res.data as Parameters<typeof parseGenerateResponse>[0]);
      }

      if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
        const errData = res.data as { error?: { message?: string } };
        const msg = errData?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }

      await Bun.sleep(RETRY_DELAYS[attempt]);
    }

    throw new Error("Unreachable");
  }

  return {
    name: "google",
    defaultModel: "gemini-3.1-flash-image-preview",
    generate: generateWithRetry,
    // Batch methods added in Task 9
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/providers/google.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): add realtime provider with request building and response parsing"
```

---

### Task 7: Generate Command

**Files:**
- Create: `scripts/commands/generate.ts`
- Test: `scripts/commands/generate.test.ts`

- [ ] **Step 1: Write generate command tests**

```typescript
// scripts/commands/generate.test.ts
import { describe, test, expect } from "bun:test";
import { validateGenerateArgs, loadPrompts } from "./generate";

describe("validateGenerateArgs", () => {
  test("requires --prompt or --prompts", () => {
    expect(() => validateGenerateArgs({})).toThrow("--prompt or --prompts is required");
  });

  test("accepts --prompt", () => {
    expect(() => validateGenerateArgs({ prompt: "A cat" })).not.toThrow();
  });

  test("accepts --prompts", () => {
    expect(() => validateGenerateArgs({ prompts: "prompts.json" })).not.toThrow();
  });

  test("rejects both --prompt and --prompts", () => {
    expect(() =>
      validateGenerateArgs({ prompt: "A cat", prompts: "prompts.json" }),
    ).toThrow("Cannot use both --prompt and --prompts");
  });
});

describe("loadPrompts", () => {
  test("single prompt creates one task", () => {
    const tasks = loadPrompts({ prompt: "A cat" }, {
      model: "test",
      ar: "1:1",
      quality: "2k" as const,
      refs: [],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe("A cat");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/commands/generate.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement generate command**

```typescript
// scripts/commands/generate.ts
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { GenerateRequest, GenerateResult, Provider } from "../providers/types";
import {
  generateSlug,
  resolveOutputPath,
  ensureOutdir,
  writeImage,
  nextSeqNumber,
  mimeToExt,
} from "../lib/output";
import type { Config } from "../lib/config";
import { mapQualityToImageSize } from "../providers/google";

export interface GenerateFlags {
  prompt?: string;
  prompts?: string;
  ref?: string[];
}

export function validateGenerateArgs(flags: GenerateFlags): void {
  if (!flags.prompt && !flags.prompts) {
    throw new Error("--prompt or --prompts is required");
  }
  if (flags.prompt && flags.prompts) {
    throw new Error("Cannot use both --prompt and --prompts");
  }
}

interface PromptTask {
  prompt: string;
  ar?: string;
  quality?: "normal" | "2k";
  refs: string[];
}

export function loadPrompts(
  flags: GenerateFlags,
  defaults: { model: string; ar: string; quality: "normal" | "2k"; refs: string[] },
): PromptTask[] {
  if (flags.prompt) {
    return [
      {
        prompt: flags.prompt,
        ar: defaults.ar,
        quality: defaults.quality,
        refs: flags.ref ?? defaults.refs,
      },
    ];
  }

  // Load from prompts.json
  const filePath = resolve(flags.prompts!);
  const content = readFileSync(filePath, "utf-8");
  const tasks = JSON.parse(content) as Array<{
    prompt: string;
    ar?: string;
    quality?: "normal" | "2k";
    ref?: string[];
  }>;

  const dir = dirname(filePath);
  return tasks.map((t) => ({
    prompt: t.prompt,
    ar: t.ar ?? defaults.ar,
    quality: t.quality ?? defaults.quality,
    refs: t.ref?.map((r) => resolve(dir, r)) ?? defaults.refs,
  }));
}

export async function runGenerate(
  provider: Provider,
  config: Config,
  flags: {
    prompt?: string;
    prompts?: string;
    ref?: string[];
    outdir: string;
    json: boolean;
  },
): Promise<void> {
  validateGenerateArgs(flags);
  ensureOutdir(flags.outdir);

  const tasks = loadPrompts(flags, {
    model: config.model,
    ar: config.ar,
    quality: config.quality,
    refs: flags.ref?.map((r) => resolve(r)) ?? [],
  });

  let seq = nextSeqNumber(flags.outdir);

  for (const task of tasks) {
    const req: GenerateRequest = {
      prompt: task.prompt,
      model: config.model,
      ar: task.ar ?? null,
      quality: task.quality ?? config.quality,
      refs: task.refs,
      imageSize: mapQualityToImageSize(task.quality ?? config.quality),
    };

    const result = await provider.generate(req);

    // Handle safety block
    if (result.finishReason === "SAFETY") {
      const msg = result.safetyInfo
        ? `Safety block: ${result.safetyInfo.category} — ${result.safetyInfo.reason}`
        : "Content blocked by safety filter";
      if (flags.json) {
        console.log(JSON.stringify({ error: msg, finishReason: "SAFETY", safetyInfo: result.safetyInfo }));
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    // Handle no images
    if (result.images.length === 0) {
      const msg = result.textParts?.length
        ? `Model returned text instead of image: ${result.textParts[0]}`
        : "No image generated";
      if (flags.json) {
        console.log(JSON.stringify({ error: msg, textParts: result.textParts }));
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    // Write images
    const slug = generateSlug(task.prompt);
    for (let imgIdx = 0; imgIdx < result.images.length; imgIdx++) {
      const img = result.images[imgIdx];
      const ext = mimeToExt(img.mimeType);
      const imgSlug = result.images.length > 1
        ? `${slug}-${String.fromCharCode(97 + imgIdx)}` // -a, -b, -c
        : slug;
      const outPath = resolveOutputPath(flags.outdir, imgSlug, seq, ext);
      writeImage(outPath, img.data);

      if (flags.json) {
        console.log(
          JSON.stringify({
            path: outPath,
            prompt: task.prompt,
            mimeType: img.mimeType,
            finishReason: result.finishReason,
          }),
        );
      } else {
        console.log(outPath);
      }
    }
    seq++;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/commands/generate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/commands/generate.ts scripts/commands/generate.test.ts
git commit -m "feat(generate): add realtime generation command"
```

---

### Task 8: Main Entry Point

**Files:**
- Create: `scripts/main.ts`

- [ ] **Step 1: Implement the main entry point and subcommand router**

```typescript
// scripts/main.ts
import { parseArgs } from "./lib/args";
import { resolveConfig } from "./lib/config";
import { createGoogleProvider } from "./providers/google";
import { runGenerate } from "./commands/generate";
import type { Provider } from "./providers/types";

const PROVIDERS: Record<string, (apiKey: string, baseUrl: string) => Provider> = {
  google: createGoogleProvider,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig({
    model: args.flags.model,
    provider: args.flags.provider,
    ar: args.flags.ar,
    quality: args.flags.quality,
  });

  // Validate API key
  if (!config.apiKey) {
    console.error(
      "Missing API key. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable,\n" +
      "or create a .env file at .jdy-imagine/.env or ~/.jdy-imagine/.env",
    );
    process.exit(1);
  }

  // Create provider
  const providerFactory = PROVIDERS[config.provider];
  if (!providerFactory) {
    console.error(`Unknown provider: ${config.provider}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
    process.exit(1);
  }
  const provider = providerFactory(config.apiKey, config.baseUrl);

  switch (args.command) {
    case "generate":
      await runGenerate(provider, config, {
        prompt: args.flags.prompt,
        prompts: args.flags.prompts,
        ref: args.flags.ref,
        outdir: args.flags.outdir,
        json: args.flags.json,
      });
      break;

    case "batch": {
      // Dynamically import to avoid loading batch code for generate-only usage
      const { runBatch } = await import("./commands/batch");
      await runBatch(provider, config, args);
      break;
    }

    default:
      console.error(
        "Usage: bun scripts/main.ts <command> [options]\n\n" +
        "Commands:\n" +
        "  generate   Generate images in realtime\n" +
        "  batch      Batch image generation (submit/status/fetch/list/cancel)\n",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Create minimal batch.ts stub** (so dynamic import resolves)

```typescript
// scripts/commands/batch.ts — stub, replaced in Task 10
import type { Provider } from "../providers/types";
import type { Config } from "../lib/config";
import type { ParsedArgs } from "../lib/args";

export async function runBatch(
  _provider: Provider,
  _config: Config,
  _args: ParsedArgs,
): Promise<void> {
  console.error("Batch commands not yet implemented");
  process.exit(1);
}
```

- [ ] **Step 3: Verify the entry point compiles**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun build scripts/main.ts --outdir /tmp/jdy-imagine-check --target bun 2>&1 | head -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add scripts/main.ts scripts/commands/batch.ts
git commit -m "feat(main): add entry point with subcommand routing"
```

---

### Task 9: Google Provider — Batch Methods

**Files:**
- Modify: `scripts/providers/google.ts`
- Modify: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write batch method tests**

Add to `scripts/providers/google.test.ts`:

```typescript
import {
  buildRealtimeRequestBody,
  parseGenerateResponse,
  mapQualityToImageSize,
  buildBatchRequestBody,
  parseBatchResponse,
  validateBatchTasks,
} from "./google";

describe("validateBatchTasks", () => {
  test("passes for text-only tasks", () => {
    const tasks = [
      { prompt: "A cat", model: "test", ar: null, quality: "2k" as const, refs: [], imageSize: "2K" as const },
    ];
    expect(() => validateBatchTasks(tasks)).not.toThrow();
  });

  test("rejects tasks with refs", () => {
    const tasks = [
      { prompt: "Edit this", model: "test", ar: null, quality: "2k" as const, refs: ["a.png"], imageSize: "2K" as const },
    ];
    expect(() => validateBatchTasks(tasks)).toThrow("Batch mode does not support reference images in v0.1");
  });
});

describe("buildBatchRequestBody", () => {
  test("builds inline batch request", () => {
    const body = buildBatchRequestBody(
      "gemini-3.1-flash-image-preview",
      [
        { prompt: "A sunset", model: "test", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" },
      ],
      "test-batch",
    );
    expect(body.batch.display_name).toBe("test-batch");
    expect(body.batch.input_config.requests.requests).toHaveLength(1);
    const req = body.batch.input_config.requests.requests[0];
    expect(req.metadata.key).toMatch(/^001-/);
  });
});

describe("parseBatchResponse", () => {
  test("parses inline batch results", () => {
    const apiResponse = {
      inlinedResponses: [
        {
          metadata: { key: "001-cat" },
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from("img").toString("base64"),
                        mimeType: "image/png",
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      ],
    };
    const results = parseBatchResponse(apiResponse);
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("001-cat");
    expect(results[0].result?.images).toHaveLength(1);
  });

  test("handles batch item errors", () => {
    const apiResponse = {
      inlinedResponses: [
        {
          metadata: { key: "001-fail" },
          response: {
            error: { message: "Content blocked" },
          },
        },
      ],
    };
    const results = parseBatchResponse(apiResponse);
    expect(results[0].error).toBe("Content blocked");
  });
});
```

- [ ] **Step 2: Run test to verify new tests fail**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/providers/google.test.ts`
Expected: FAIL — new functions not exported yet

- [ ] **Step 3: Add batch methods to google.ts**

Add these exports to `scripts/providers/google.ts`:

```typescript
import type {
  GenerateRequest,
  GenerateResult,
  BatchCreateRequest,
  BatchJob,
  BatchResult,
  Provider,
} from "./types";
import { generateSlug } from "../lib/output";

export function validateBatchTasks(tasks: GenerateRequest[]): void {
  for (const task of tasks) {
    if (task.refs.length > 0) {
      throw new Error(
        "Batch mode does not support reference images in v0.1. Use `generate` for image-to-image tasks.",
      );
    }
  }
}

export function buildBatchRequestBody(
  model: string,
  tasks: GenerateRequest[],
  displayName: string,
): {
  batch: {
    display_name: string;
    input_config: {
      requests: {
        requests: Array<{
          request: {
            contents: Array<{ parts: Array<Record<string, unknown>> }>;
            generationConfig: {
              responseModalities: string[];
              imageConfig: { imageSize: string };
            };
          };
          metadata: { key: string };
        }>;
      };
    };
  };
} {
  const requests = tasks.map((task, i) => {
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(task.prompt);
    let promptText = task.prompt;
    if (task.ar) {
      promptText += `. Aspect ratio: ${task.ar}.`;
    }
    return {
      request: {
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { imageSize: task.imageSize },
        },
      },
      metadata: { key: `${seq}-${slug}` },
    };
  });

  return {
    batch: {
      display_name: displayName,
      input_config: {
        requests: { requests },
      },
    },
  };
}

export function parseBatchResponse(apiResponse: {
  inlinedResponses?: Array<{
    metadata?: { key?: string };
    response?: {
      candidates?: Array<{
        content?: { parts?: Array<Record<string, unknown>> };
        finishReason?: string;
        safetyRatings?: Array<{ category: string; probability: string }>;
      }>;
      error?: { message?: string };
    };
  }>;
}): BatchResult[] {
  const responses = apiResponse.inlinedResponses ?? [];
  return responses.map((entry) => {
    const key = entry.metadata?.key ?? "unknown";

    if (entry.response?.error) {
      return { key, error: entry.response.error.message ?? "Unknown error" };
    }

    const result = parseGenerateResponse(
      entry.response as Parameters<typeof parseGenerateResponse>[0],
    );
    return { key, result };
  });
}
```

Then update `createGoogleProvider` to include batch methods:

```typescript
// Add to createGoogleProvider return object:
async batchCreate(req: BatchCreateRequest): Promise<BatchJob> {
  validateBatchTasks(req.tasks);

  const displayName = req.displayName ?? `jdy-imagine-${Date.now()}`;
  const body = buildBatchRequestBody(req.model, req.tasks, displayName);

  // Check payload size (rough estimate)
  const payloadSize = JSON.stringify(body).length;
  if (payloadSize > 20 * 1024 * 1024) {
    throw new Error(
      "Batch payload exceeds 20MB. Split into smaller batches.",
    );
  }

  const url = `${baseUrl}/v1beta/models/${req.model}:batchGenerateContent`;
  const res = await httpPostWithRetry(url, body, apiKey);

  if (res.status !== 200) {
    const errData = res.data as { error?: { message?: string } };
    throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = res.data as {
    name?: string;
    metadata?: { state?: string; createTime?: string };
  };
  return {
    id: data.name ?? "",
    state: (data.metadata?.state?.toLowerCase() ?? "pending") as BatchJob["state"],
    createTime: data.metadata?.createTime ?? new Date().toISOString(),
  };
},

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
  };
  return {
    id: data.name ?? jobId,
    state: (data.metadata?.state?.toLowerCase() ?? "pending") as BatchJob["state"],
    createTime: data.metadata?.createTime ?? "",
    stats: data.metadata?.totalCount != null
      ? {
          total: data.metadata.totalCount,
          succeeded: data.metadata.succeededCount ?? 0,
          failed: data.metadata.failedCount ?? 0,
        }
      : undefined,
  };
},

async batchFetch(jobId: string): Promise<BatchResult[]> {
  const url = `${baseUrl}/v1beta/${jobId}`;
  const res = await httpGetWithRetry(url, apiKey);

  if (res.status !== 200) {
    const errData = res.data as { error?: { message?: string } };
    throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = res.data as { response?: Record<string, unknown> };
  return parseBatchResponse(data.response ?? data as Parameters<typeof parseBatchResponse>[0]);
},

async batchList(): Promise<BatchJob[]> {
  const url = `${baseUrl}/v1beta/batches`;
  const res = await httpGetWithRetry(url, apiKey);

  if (res.status !== 200) {
    const errData = res.data as { error?: { message?: string } };
    throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = res.data as {
    batches?: Array<{
      name?: string;
      metadata?: { state?: string; createTime?: string };
    }>;
  };
  return (data.batches ?? []).map((b) => ({
    id: b.name ?? "",
    state: (b.metadata?.state?.toLowerCase() ?? "pending") as BatchJob["state"],
    createTime: b.metadata?.createTime ?? "",
  }));
},

async batchCancel(jobId: string): Promise<void> {
  const url = `${baseUrl}/v1beta/${jobId}:cancel`;
  const res = await httpPostWithRetry(url, {}, apiKey);

  if (res.status !== 200) {
    const errData = res.data as { error?: { message?: string } };
    throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
  }
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/providers/google.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): add batch methods to Google provider"
```

---

### Task 10: Batch Command

**Files:**
- Modify: `scripts/commands/batch.ts` (replace stub from Task 8)
- Test: `scripts/commands/batch.test.ts`

- [ ] **Step 1: Write batch manifest tests**

```typescript
// scripts/commands/batch.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { saveManifest, loadManifest, type BatchManifest } from "./batch";

describe("saveManifest", () => {
  test("persists manifest to .jdy-imagine-batch dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    const manifest: BatchManifest = {
      jobId: "batches/abc123",
      model: "gemini-3.1-flash-image-preview",
      createTime: "2026-04-13T10:00:00Z",
      outdir: dir,
      tasks: [
        { key: "001-sunset", prompt: "A sunset over mountains", ar: "16:9" },
      ],
    };

    saveManifest(dir, manifest);

    const manifestDir = join(dir, ".jdy-imagine-batch");
    expect(existsSync(manifestDir)).toBe(true);

    // Job ID contains slash, so file uses sanitized name
    const files = Bun.glob("*.json").scanSync({ cwd: manifestDir });
    const found = [...files];
    expect(found).toHaveLength(1);
  });
});

describe("loadManifest", () => {
  test("loads saved manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    const manifest: BatchManifest = {
      jobId: "batches/abc123",
      model: "test-model",
      createTime: "2026-04-13T10:00:00Z",
      outdir: dir,
      tasks: [{ key: "001-cat", prompt: "A cat" }],
    };

    saveManifest(dir, manifest);
    const loaded = loadManifest(dir, "batches/abc123");
    expect(loaded).not.toBeNull();
    expect(loaded!.jobId).toBe("batches/abc123");
    expect(loaded!.tasks).toHaveLength(1);
  });

  test("returns null for missing manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    expect(loadManifest(dir, "batches/missing")).toBeNull();
  });
});
```

- [ ] **Step 1b: Write writeResults tests** (add to same test file)

```typescript
// Add to scripts/commands/batch.test.ts
import { writeResults } from "./batch";
import type { BatchResult } from "../providers/types";

describe("writeResults", () => {
  test("multi-image results get -a, -b suffixes", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    const results: BatchResult[] = [
      {
        key: "001-cat",
        result: {
          images: [
            { data: new Uint8Array([1]), mimeType: "image/png" },
            { data: new Uint8Array([2]), mimeType: "image/png" },
          ],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-cat-a.png"))).toBe(true);
    expect(existsSync(join(dir, "001-cat-b.png"))).toBe(true);
  });

  test("JPEG mimeType produces .jpg extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    const results: BatchResult[] = [
      {
        key: "001-photo",
        result: {
          images: [{ data: new Uint8Array([1]), mimeType: "image/jpeg" }],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-photo.jpg"))).toBe(true);
  });

  test("collision handling avoids overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    // Pre-create a file
    writeFileSync(join(dir, "001-cat.png"), "existing");
    const results: BatchResult[] = [
      {
        key: "001-cat",
        result: {
          images: [{ data: new Uint8Array([1]), mimeType: "image/png" }],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-cat-2.png"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/commands/batch.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement batch command**

```typescript
// scripts/commands/batch.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import type { Provider, GenerateRequest, BatchResult } from "../providers/types";
import type { Config } from "../lib/config";
import type { ParsedArgs } from "../lib/args";
import { generateSlug, resolveOutputPath, ensureOutdir, writeImage, mimeToExt } from "../lib/output";
import { mapQualityToImageSize } from "../providers/google";


export interface BatchManifest {
  jobId: string;
  model: string;
  createTime: string;
  outdir: string;
  tasks: Array<{
    key: string;
    prompt: string;
    ar?: string;
    quality?: string;
  }>;
}

export function saveManifest(outdir: string, manifest: BatchManifest): void {
  const dir = join(outdir, ".jdy-imagine-batch");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Sanitize job ID for filename (e.g. "batches/abc123" → "batches_abc123")
  const filename = manifest.jobId.replace(/\//g, "_") + ".json";
  writeFileSync(join(dir, filename), JSON.stringify(manifest, null, 2));
}

export function loadManifest(
  outdir: string,
  jobId: string,
): BatchManifest | null {
  const dir = join(outdir, ".jdy-imagine-batch");
  const filename = jobId.replace(/\//g, "_") + ".json";
  const path = join(dir, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export async function runBatch(
  provider: Provider,
  config: Config,
  args: ParsedArgs,
): Promise<void> {
  const sub = args.subcommand;

  if (!sub) {
    console.error(
      "Usage: bun scripts/main.ts batch <submit|status|fetch|list|cancel> [args]",
    );
    process.exit(1);
  }

  switch (sub) {
    case "submit":
      await batchSubmit(provider, config, args);
      break;
    case "status":
      await batchStatus(provider, args);
      break;
    case "fetch":
      await batchFetch(provider, config, args);
      break;
    case "list":
      await batchList(provider, args);
      break;
    case "cancel":
      await batchCancel(provider, args);
      break;
    default:
      console.error(`Unknown batch subcommand: ${sub}`);
      process.exit(1);
  }
}

async function batchSubmit(
  provider: Provider,
  config: Config,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchCreate) {
    throw new Error(`Provider ${provider.name} does not support batch operations`);
  }

  if (!args.positional) {
    throw new Error("Usage: batch submit <prompts.json> [--outdir dir] [--async]");
  }

  const filePath = resolve(args.positional);
  const content = readFileSync(filePath, "utf-8");
  const rawTasks = JSON.parse(content) as Array<{
    prompt: string;
    ar?: string;
    quality?: "normal" | "2k";
    ref?: string[];
  }>;

  const dir = dirname(filePath);
  const tasks: GenerateRequest[] = rawTasks.map((t) => ({
    prompt: t.prompt,
    model: config.model,
    ar: t.ar ?? config.ar,
    quality: t.quality ?? config.quality,
    refs: t.ref?.map((r) => resolve(dir, r)) ?? [],
    imageSize: mapQualityToImageSize(t.quality ?? config.quality),
  }));

  const outdir = args.flags.outdir;
  ensureOutdir(outdir);

  const job = await provider.batchCreate({
    model: config.model,
    tasks,
    displayName: `jdy-imagine-${Date.now()}`,
  });

  // Save manifest for async jobs
  const manifestTasks = tasks.map((t, i) => {
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(t.prompt);
    return {
      key: `${seq}-${slug}`,
      prompt: t.prompt,
      ar: t.ar ?? undefined,
      quality: t.quality,
    };
  });

  const manifest: BatchManifest = {
    jobId: job.id,
    model: config.model,
    createTime: job.createTime,
    outdir: resolve(outdir),
    tasks: manifestTasks,
  };
  saveManifest(outdir, manifest);

  if (args.flags.async) {
    // Async mode: return job ID immediately
    if (args.flags.json) {
      console.log(JSON.stringify({ jobId: job.id, state: job.state }));
    } else {
      console.log(`Job submitted: ${job.id}`);
      console.log(`Check status: bun scripts/main.ts batch status ${job.id}`);
    }
    return;
  }

  // Sync mode: poll until complete
  console.log(`Job submitted: ${job.id}. Waiting for completion...`);
  await pollAndFetch(provider, config, job.id, outdir, args.flags.json, manifest);
}

async function pollAndFetch(
  provider: Provider,
  config: Config,
  jobId: string,
  outdir: string,
  jsonOutput: boolean,
  manifest: BatchManifest | null,
): Promise<void> {
  if (!provider.batchGet || !provider.batchFetch) {
    throw new Error("Provider does not support batch get/fetch");
  }

  const startTime = Date.now();
  const MAX_WAIT = 48 * 60 * 60 * 1000; // 48 hours
  let pollInterval = 5000; // 5s initially
  const INCREASE_AFTER = 60_000; // switch to 15s after 1 min

  while (true) {
    const job = await provider.batchGet(jobId);

    if (job.state === "succeeded") {
      const results = await provider.batchFetch(jobId);
      writeResults(results, outdir, jsonOutput, manifest);
      return;
    }

    if (job.state === "failed") {
      console.error(`Batch job failed.`);
      if (job.stats) {
        console.error(`Stats: ${job.stats.succeeded} succeeded, ${job.stats.failed} failed`);
      }
      process.exit(1);
    }

    if (job.state === "cancelled") {
      console.error("Batch job was cancelled.");
      process.exit(1);
    }

    if (job.state === "expired") {
      console.error("Batch job expired (48h server-side limit). Resubmit the job.");
      process.exit(1);
    }

    if (Date.now() - startTime > MAX_WAIT) {
      console.error("Batch job timed out after 48 hours. Resubmit the job.");
      process.exit(1);
    }

    if (Date.now() - startTime > INCREASE_AFTER) {
      pollInterval = 15000;
    }

    await Bun.sleep(pollInterval);
  }
}

export function writeResults(
  results: BatchResult[],
  outdir: string,
  jsonOutput: boolean,
  manifest: BatchManifest | null,
): void {
  ensureOutdir(outdir);
  let written = 0;

  for (const r of results) {
    if (r.error) {
      if (jsonOutput) {
        console.log(JSON.stringify({ key: r.key, error: r.error }));
      } else {
        console.error(`[${r.key}] Error: ${r.error}`);
      }
      continue;
    }

    if (!r.result || r.result.images.length === 0) {
      const msg = r.result?.finishReason === "SAFETY"
        ? `Safety block: ${r.result.safetyInfo?.reason ?? "unknown"}`
        : "No image generated";
      if (jsonOutput) {
        console.log(JSON.stringify({ key: r.key, error: msg }));
      } else {
        console.error(`[${r.key}] ${msg}`);
      }
      continue;
    }

    // Use manifest to recover original naming context; fallback to remote key
    const manifestTask = manifest?.tasks.find((t) => t.key === r.key);
    const baseKey = r.key;

    for (let imgIdx = 0; imgIdx < r.result.images.length; imgIdx++) {
      const img = r.result.images[imgIdx];
      const ext = mimeToExt(img.mimeType);
      const imgKey = r.result.images.length > 1
        ? `${baseKey}-${String.fromCharCode(97 + imgIdx)}`
        : baseKey;
      // Collision handling: don't overwrite existing files
      let outPath = join(outdir, `${imgKey}${ext}`);
      let collisionSuffix = 2;
      while (existsSync(outPath)) {
        outPath = join(outdir, `${imgKey}-${collisionSuffix}${ext}`);
        collisionSuffix++;
      }
      writeImage(outPath, img.data);
      written++;

      if (jsonOutput) {
        console.log(JSON.stringify({
          key: r.key,
          path: outPath,
          prompt: manifestTask?.prompt,
        }));
      } else {
        console.log(outPath);
      }
    }
  }

  if (!jsonOutput) {
    console.log(`\n${written} image(s) saved to ${outdir}`);
  }
}

async function batchStatus(
  provider: Provider,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchGet) {
    throw new Error("Provider does not support batch operations");
  }
  if (!args.positional) {
    throw new Error("Usage: batch status <jobId>");
  }

  const job = await provider.batchGet(args.positional);

  if (args.flags.json) {
    console.log(JSON.stringify(job));
  } else {
    console.log(`Job: ${job.id}`);
    console.log(`State: ${job.state}`);
    console.log(`Created: ${job.createTime}`);
    if (job.stats) {
      console.log(
        `Progress: ${job.stats.succeeded}/${job.stats.total} succeeded, ${job.stats.failed} failed`,
      );
    }
  }
}

async function batchFetch(
  provider: Provider,
  config: Config,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchFetch) {
    throw new Error("Provider does not support batch fetch");
  }
  if (!args.positional) {
    throw new Error("Usage: batch fetch <jobId> --outdir <dir>");
  }

  const outdir = args.flags.outdir;
  const manifest = loadManifest(outdir, args.positional);
  if (!manifest) {
    console.error(
      `Warning: No local manifest found for ${args.positional}. Output naming may differ from original submission.`,
    );
  }

  const results = await provider.batchFetch(args.positional);
  writeResults(results, outdir, args.flags.json, manifest);
}

async function batchList(
  provider: Provider,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchList) {
    throw new Error("Provider does not support batch list");
  }

  const jobs = await provider.batchList();

  if (args.flags.json) {
    console.log(JSON.stringify(jobs));
  } else {
    if (jobs.length === 0) {
      console.log("No batch jobs found.");
      return;
    }
    for (const job of jobs) {
      const manifest = loadManifest(args.flags.outdir, job.id);
      const info = manifest
        ? ` (${manifest.tasks.length} tasks, outdir: ${manifest.outdir})`
        : "";
      console.log(`${job.id}  ${job.state}  ${job.createTime}${info}`);
    }
  }
}

async function batchCancel(
  provider: Provider,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchCancel) {
    throw new Error("Provider does not support batch cancel");
  }
  if (!args.positional) {
    throw new Error("Usage: batch cancel <jobId>");
  }

  await provider.batchCancel(args.positional);
  console.log(`Job ${args.positional} cancelled.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/commands/batch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/commands/batch.ts scripts/commands/batch.test.ts
git commit -m "feat(batch): add batch submit/status/fetch/list/cancel command"
```

---

### Task 11: Plugin Metadata & SKILL.md

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `SKILL.md`

- [ ] **Step 1: Create plugin metadata**

```json
{
  "name": "jdy-imagine",
  "version": "0.1.0",
  "description": "AI image generation with Google Batch API support",
  "skills": ["jdy-imagine"]
}
```

- [ ] **Step 2: Create SKILL.md**

```markdown
---
name: jdy-imagine
description: AI image generation via Google Gemini (realtime + batch). Text-to-image, image-to-image, batch generation at 50% cost.
---

# jdy-imagine

AI image generation plugin for Claude Code.

## Usage

### Text-to-image
```bash
bun scripts/main.ts generate --prompt "A cat in watercolor style" --outdir ./images
```

### Image-to-image
```bash
bun scripts/main.ts generate --prompt "Make it blue" --ref source.png --outdir ./images
```

### Batch generation (50% cost savings)
```bash
bun scripts/main.ts batch submit prompts.json --outdir ./images
```

### Options
- `--model`, `-m`: Model ID (default: gemini-3.1-flash-image-preview)
- `--ar`: Aspect ratio (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3)
- `--quality`: normal / 2k (default: 2k)
- `--ref`: Reference image path(s) for image-to-image
- `--outdir`, `-o`: Output directory (default: .)
- `--json`: JSON output mode

### Configuration
Set `GOOGLE_API_KEY` or `GEMINI_API_KEY` environment variable, or create `.jdy-imagine/.env`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/marketplace.json SKILL.md
git commit -m "feat: add plugin metadata and SKILL.md"
```

---

### Task 12: Integration Smoke Test

**Files:**
- Create: `scripts/integration.test.ts`

- [ ] **Step 1: Write integration test with mock provider**

```typescript
// scripts/integration.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseArgs } from "./lib/args";
import { generateSlug, buildOutputPath, nextSeqNumber } from "./lib/output";
import { parseExtendMd, parseDotEnv, mergeConfig } from "./lib/config";
import { buildRealtimeRequestBody, parseGenerateResponse } from "./providers/google";
import { validateGenerateArgs, loadPrompts } from "./commands/generate";
import { saveManifest, loadManifest } from "./commands/batch";

describe("Integration: CLI → provider → output pipeline", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "jdy-imagine-int-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("full pipeline: args → config → request → response → output", () => {
    // 1. Parse args
    const args = parseArgs([
      "generate",
      "--prompt", "A sunset over mountains",
      "--ar", "16:9",
      "--quality", "2k",
      "--outdir", tempDir,
    ]);
    expect(args.command).toBe("generate");

    // 2. Merge config
    const config = mergeConfig(
      { model: args.flags.model, ar: args.flags.ar, quality: args.flags.quality },
      {},
      { GOOGLE_API_KEY: "test-key" },
    );
    expect(config.model).toBe("gemini-3.1-flash-image-preview");

    // 3. Build request
    const req = buildRealtimeRequestBody({
      prompt: args.flags.prompt!,
      model: config.model,
      ar: args.flags.ar ?? config.ar,
      quality: config.quality,
      refs: [],
      imageSize: "2K",
    });
    expect(req.contents[0].parts[0].text).toContain("A sunset");

    // 4. Parse a mock response
    const mockApiResponse = {
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              data: Buffer.from("fake-png-data").toString("base64"),
              mimeType: "image/png",
            },
          }],
        },
        finishReason: "STOP",
      }],
    };
    const result = parseGenerateResponse(mockApiResponse);
    expect(result.images).toHaveLength(1);

    // 5. Generate slug and output path
    const slug = generateSlug(args.flags.prompt!);
    expect(slug).toBe("a-sunset-over-mountains");
    const seq = nextSeqNumber(tempDir);
    const outPath = buildOutputPath(tempDir, slug, seq);
    expect(outPath).toContain("001-a-sunset-over-mountains.png");
  });

  test("batch manifest round-trip", () => {
    const manifest = {
      jobId: "batches/test123",
      model: "gemini-3.1-flash-image-preview",
      createTime: "2026-04-13T10:00:00Z",
      outdir: tempDir,
      tasks: [
        { key: "001-sunset", prompt: "A sunset" },
        { key: "002-cat", prompt: "A cat" },
      ],
    };
    saveManifest(tempDir, manifest);
    const loaded = loadManifest(tempDir, "batches/test123");
    expect(loaded).not.toBeNull();
    expect(loaded!.tasks).toHaveLength(2);
  });

  test("prompts.json loading and validation", () => {
    const promptsFile = join(tempDir, "test-prompts.json");
    writeFileSync(promptsFile, JSON.stringify([
      { "prompt": "A sunset", "ar": "16:9" },
      { "prompt": "A cat portrait" },
    ]));

    const tasks = loadPrompts(
      { prompts: promptsFile },
      { model: "test", ar: "1:1", quality: "2k", refs: [] },
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].ar).toBe("16:9");
    expect(tasks[1].ar).toBe("1:1"); // inherited default
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test scripts/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `cd /Users/jdy/Documents/skills/jdy-imagine && bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add scripts/integration.test.ts
git commit -m "test: add integration smoke test"
```
