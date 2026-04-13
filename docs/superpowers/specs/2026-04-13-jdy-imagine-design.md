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

# List all jobs
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
  image: Uint8Array
  mimeType: string      // "image/png" | "image/jpeg"
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
  image?: Uint8Array
  mimeType?: string
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

Response extraction: `candidates[0].content.parts[].inlineData.data` → base64 → Uint8Array.

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

For large batches (> 20MB): upload JSONL via File API (`POST /upload/v1beta/files`), then reference `input_config.file_name`.

**Poll** — `GET /v1beta/{batchName}`

Returns `BatchJob` with `state`. Poll interval: 5s for first minute, then 15s, capped at 48h timeout.

**Fetch results**:
- Inline: `response.inlinedResponses[]`
- File: `GET /download/v1beta/{responseFile}:download?alt=media` → JSONL, parse line by line

**List** — `GET /v1beta/batches`

**Cancel** — `POST /v1beta/{batchName}:cancel`

### Image Size Mapping

| quality | imageSize | Approx cost (standard / batch) |
|---------|-----------|-------------------------------|
| `normal` | `1K` | $0.067 / $0.034 |
| `2k` | `2K` | $0.101 / $0.050 |

### Supported Models

| Model | Realtime | Batch | Ref images |
|-------|----------|-------|------------|
| `gemini-3.1-flash-image-preview` (default) | ✅ | ✅ | ✅ |
| `gemini-3-pro-image-preview` | ✅ | ✅ | ✅ |
| `gemini-3-flash-preview` | ✅ | ✅ | ✅ |

## Output Naming

Pattern: `{outdir}/{NNN}-{slug}.png`

Slug generation:
1. Extract words from prompt (split on whitespace and punctuation)
2. Take first 4 tokens (English words kept as-is, CJK characters kept as-is)
3. Lowercase, join with `-`
4. Truncate to 40 characters
5. Strip trailing `-`

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
| Ref image with unsupported model | Exit with supported model list |
| Output dir not writable | Exit with permission error |

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
- Batch file-based submission via File API (inline only in v0.1, covers most use cases under 20MB)
- EXTEND.md first-time setup wizard
- Prompt files (`--promptfiles`)
