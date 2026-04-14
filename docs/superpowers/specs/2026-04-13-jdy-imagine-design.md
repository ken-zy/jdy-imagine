# jdy-imagine Design Spec

## Overview

Lightweight Claude Code plugin for AI image generation. First-class Google support (realtime + Batch API at 50% cost), provider-extensible architecture. Zero npm dependencies, TypeScript + Bun.

## CLI Interface

Single entry point: `scripts/main.ts`, subcommand routing.

### Realtime Generation

```bash
# Text-to-image
bun scripts/main.ts generate --prompt "A cat in watercolor style" --outdir ./images

# Image-to-image
bun scripts/main.ts generate --prompt "Make it blue" --ref source.png --outdir ./images

# With options
bun scripts/main.ts generate --prompt "A landscape" --ar 16:9 --quality 2k --outdir ./images

# Multiple prompts in one command (sequential realtime)
bun scripts/main.ts generate --prompts prompts.json --outdir ./images
```

### Batch Generation

```bash
# Synchronous (wait for completion, default)
bun scripts/main.ts batch submit prompts.json --outdir ./images

# Asynchronous (return job ID immediately)
bun scripts/main.ts batch submit prompts.json --outdir ./images --async

# Check status
bun scripts/main.ts batch status <jobId>

# Fetch results (for async jobs)
bun scripts/main.ts batch fetch <jobId> --outdir ./images

# List all jobs (remote API, optionally annotated with local manifests)
bun scripts/main.ts batch list

# Cancel a job
bun scripts/main.ts batch cancel <jobId>
```

### prompts.json Format

```json
[
  { "prompt": "A sunset over mountains", "ar": "16:9" },
  { "prompt": "Make it darker", "ref": ["base.png"], "quality": "2k" },
  { "prompt": "A cat portrait" }
]
```

Per-task fields override global CLI args. Paths in `ref` resolve relative to the JSON file's directory.

Batch mode supports `ref` (reference images) by inlining them as base64 in the request body, same as realtime mode. This counts toward the 20MB inline payload limit.

### Global Options

| Flag | Description | Default |
|------|-------------|---------|
| `--provider` | Provider name | `google` |
| `--model`, `-m` | Model ID | `gemini-3.1-flash-image-preview` |
| `--ar` | Aspect ratio (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`) | `1:1` |
| `--quality` | `normal` / `2k` | `2k` |
| `--ref` | Reference image path(s) | — |
| `--outdir`, `-o` | Output directory | `.` |
| `--json` | JSON output | false |

## File Structure

```
jdy-imagine/
├── .claude-plugin/
│   └── marketplace.json        # Plugin metadata
├── SKILL.md                    # Skill documentation (YAML front matter + usage)
├── scripts/
│   ├── main.ts                 # Entry point, subcommand router
│   ├── commands/
│   │   ├── generate.ts         # Realtime generation command
│   │   └── batch.ts            # Batch submit/status/fetch/list/cancel
│   ├── providers/
│   │   ├── types.ts            # Provider interface
│   │   └── google.ts           # Google provider (realtime + batch endpoints)
│   └── lib/
│       ├── args.ts             # CLI arg parsing
│       ├── config.ts           # Config loading (env, EXTEND.md)
│       ├── output.ts           # Output naming, file writing, image decoding
│       └── http.ts             # HTTP client (fetch + curl proxy fallback)
├── docs/
│   └── superpowers/
│       └── specs/              # Design docs
└── EXTEND.md.example           # Config template
```

## Provider Abstraction

```typescript
// scripts/providers/types.ts

interface GenerateRequest {
  prompt: string
  model: string
  ar: string | null
  quality: "normal" | "2k"
  refs: string[]        // local file paths
  imageSize: "1K" | "2K" | "4K"
}

interface GenerateResult {
  images: Array<{
    data: Uint8Array
    mimeType: string    // "image/png" | "image/jpeg"
  }>
  finishReason: "STOP" | "SAFETY" | "MAX_TOKENS" | "OTHER"
  safetyInfo?: {
    category: string
    reason: string
  }
  textParts?: string[]  // any text returned alongside images
}

interface BatchCreateRequest {
  model: string
  tasks: GenerateRequest[]
  displayName?: string
}

interface BatchJob {
  id: string            // e.g. "batches/abc123"
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "expired"
  createTime: string
  stats?: { total: number; succeeded: number; failed: number }
}

interface BatchResult {
  key: string
  result?: GenerateResult  // same structure as realtime, including multi-image/safety/text
  error?: string
}

interface Provider {
  name: string
  defaultModel: string

  // Realtime
  generate(req: GenerateRequest): Promise<GenerateResult>

  // Batch (optional — not all providers support batch)
  batchCreate?(req: BatchCreateRequest): Promise<BatchJob>
  batchGet?(jobId: string): Promise<BatchJob>
  batchFetch?(jobId: string): Promise<BatchResult[]>
  batchList?(): Promise<BatchJob[]>
  batchCancel?(jobId: string): Promise<void>
}
```

Adding a new provider: implement `Provider` interface in `providers/<name>.ts`, register in a provider map. Only `name`, `defaultModel`, and `generate()` are required; batch methods are optional.

## Google Provider Implementation

### Realtime Mode

Uses `POST /v1beta/models/{model}:generateContent` — same endpoint as baoyu-imagine.

Request body:
```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "inlineData": { "data": "<base64>", "mimeType": "image/png" } },
      { "text": "prompt text. Aspect ratio: 16:9." }
    ]
  }],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": { "imageSize": "2K" }
  }
}
```

Response extraction:
1. Check `candidates[0].finishReason` — if `SAFETY`, return `GenerateResult` with empty `images[]` and populated `safetyInfo`
2. Iterate `candidates[0].content.parts[]`:
   - `inlineData` parts → collect into `images[]`
   - `text` parts → collect into `textParts[]`
3. If `images[]` is empty and `finishReason` is `STOP`, treat as generation failure (model returned text-only)
4. CLI behavior: first image saved to file; if multiple images returned, save all with `-a`, `-b` suffix; `--json` output includes all fields

Retry: up to 3 attempts on 429/500/503 errors, exponential backoff (1s, 2s, 4s).

### Batch Mode

**Submit** — `POST /v1beta/models/{model}:batchGenerateContent`

For inline requests (< 20MB total):
```json
{
  "batch": {
    "display_name": "jdy-imagine-<timestamp>",
    "input_config": {
      "requests": {
        "requests": [
          {
            "request": {
              "contents": [{"parts": [{"text": "A sunset"}]}],
              "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"imageSize": "2K"}}
            },
            "metadata": {"key": "001-sunset"}
          }
        ]
      }
    }
  }
}
```

v0.1 only supports inline batch (< 20MB total payload). If the computed payload exceeds 20MB, the CLI exits with an error suggesting to split into smaller batches. File API-based submission is deferred to a future version.

**Poll** — `GET /v1beta/{batchName}`

Returns `BatchJob` with `state`. Poll interval: 5s for first minute, then 15s, capped at 48h timeout.

**Fetch results** (v0.1: inline only):
- `response.inlinedResponses[]` — each entry parsed using the same extraction logic as realtime (finishReason, safety, multi-image)
- File-based response download (`GET /download/v1beta/{responseFile}:download`) is deferred to a future version alongside File API submission

**List** — `GET /v1beta/batches`

**Cancel** — `POST /v1beta/{batchName}:cancel`

### Batch Manifest (Async Jobs)

When `--async` is used, the CLI persists a manifest file at `{outdir}/.jdy-imagine-batch/{jobId}.json`:

```json
{
  "jobId": "batches/abc123",
  "model": "gemini-3.1-flash-image-preview",
  "createTime": "2026-04-13T10:00:00Z",
  "outdir": "./images",
  "tasks": [
    { "key": "001-sunset", "prompt": "A sunset over mountains", "ar": "16:9" },
    { "key": "002-cat", "prompt": "A cat portrait" }
  ]
}
```

`batch fetch <jobId>` reads this manifest to reconstruct prompt→output mapping. If manifest is missing, fetch falls back to using the batch API's `metadata.key` field for naming, with a warning that original prompt context is unavailable.

`batch list` queries the remote API (`GET /v1beta/batches`) for all jobs. If `--outdir` is specified, it also cross-references local manifests in `{outdir}/.jdy-imagine-batch/` to annotate jobs with local context (original prompts, output paths).

### Image Size Mapping

| quality | imageSize | Approx cost (standard / batch) |
|---------|-----------|-------------------------------|
| `normal` | `1K` | $0.067 / $0.034 |
| `2k` | `2K` | $0.101 / $0.050 |

### Supported Models

| Model | Realtime | Batch | Ref images | Notes |
|-------|----------|-------|------------|-------|
| `gemini-2.5-flash-image` | ✅ | ✅ | ✅ | GA image generation model |
| `gemini-3.1-flash-image-preview` (default) | ✅ | ✅ | ✅ | Preview — may change |
| `gemini-3-pro-image-preview` | ✅ | ✅ | ✅ | Preview — may change |

Note: This is a verified allowlist based on Google's official image generation documentation as of 2026-04-13. Models not in this list may work but are untested. `gemini-3-flash-preview` was removed — it does not support image generation output per official docs. The `--model` flag accepts any model ID; the allowlist only affects default selection and documentation.

## Output Naming

Pattern: `{outdir}/{NNN}-{slug}.png`

Slug generation:
1. Unicode NFC normalization
2. Strip emoji, zero-width characters, and control characters
3. Extract words from prompt (split on whitespace and punctuation)
4. Take first 4 tokens (English words kept as-is, CJK characters kept as-is)
5. Lowercase, join with `-`
6. Remove OS-reserved characters (`<>:"/\|?*`, ASCII control chars 0-31)
7. Truncate to 40 characters
8. Strip trailing `-` and `.`
9. If slug is empty after sanitization, fall back to `NNN-img.png`

Examples:
- `"A sunset over mountains"` → `001-a-sunset-over-mountains.png`
- `"一只可爱的猫在花园里"` → `002-一只可爱的猫在花园里.png`
- `"Create a detailed architectural blueprint"` → `003-create-a-detailed-architectural.png`

`outdir` is created automatically if it doesn't exist.

Collision handling: if file exists, append `-2`, `-3`, etc.

## Configuration

### Priority (highest → lowest)

1. CLI flags
2. EXTEND.md
3. Environment variables
4. Built-in defaults

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GOOGLE_API_KEY` | Google API key (primary) |
| `GEMINI_API_KEY` | Google API key (alias) |
| `GOOGLE_IMAGE_MODEL` | Default model override |
| `GOOGLE_BASE_URL` | Custom endpoint |

### EXTEND.md

Location search order:
1. `<cwd>/.jdy-imagine/EXTEND.md`
2. `~/.config/jdy-imagine/EXTEND.md`
3. `~/.jdy-imagine/EXTEND.md`

```yaml
---
default_provider: google
default_model: gemini-3.1-flash-image-preview
default_quality: 2k
default_ar: "1:1"
---
```

### .env Loading

Search order: `<cwd>/.jdy-imagine/.env` → `~/.jdy-imagine/.env`

Simple KEY=VALUE parser, only sets if not already in environment.

## HTTP Client

`scripts/lib/http.ts` — thin wrapper:

- Default: Bun `fetch`
- Proxy detected (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`): shell out to `curl` via `execFileSync` (Bun fetch has known proxy issues)
- Timeout: 30s connect, 300s total
- Auth: `x-goog-api-key` header

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Missing API key | Exit with setup instructions |
| 429 rate limit (realtime) | Retry up to 3x, exponential backoff |
| 400 bad request | Exit with error detail, no retry |
| 401/403 auth error | Exit with "check API key" message |
| 500/503 server error | Retry up to 3x |
| Batch job failed | Report per-task errors |
| Batch job expired (48h) | Report timeout, suggest resubmit |
| Ref image not found | Exit with file path in error |
| Ref image rejected by API (model doesn't support refs) | Forward API error with hint to check supported models in docs |
| Output dir not writable | Exit with permission error |
| Safety block (finishReason=SAFETY) | Exit with safety category/reason, no retry |
| No image in response (text-only) | Exit with "model returned text instead of image" |
| Batch task ref image not found | Exit with file path in error |
| Batch payload > 20MB | Exit with "payload too large, split into smaller batches" |

## Plugin Metadata

```json
{
  "name": "jdy-imagine",
  "version": "0.1.0",
  "description": "AI image generation with Google Batch API support",
  "skills": ["jdy-imagine"]
}
```

## What's NOT in v0.1

- Other providers (OpenAI, Replicate, etc.) — architecture supports it, not implemented
- `--image` single file output (use `--outdir` only)
- Batch file-based submission via File API — inline only, CLI enforces 20MB limit with clear error
- Batch + reference images via File API — inline base64 only (counts toward 20MB limit)
- EXTEND.md first-time setup wizard
- Prompt files (`--promptfiles`)
- Runtime model capability detection — models are configurable via `--model` / env var
