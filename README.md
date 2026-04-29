# jdy-imagine

AI image generation plugin for Claude Code. Supports **Google Gemini**, **OpenAI gpt-image-2**, and **apimart** (China gateway for gpt-image-2). Realtime + Batch API, character consistency, chain mode (Gemini), edit with mask (OpenAI/apimart), 4K + 13-value aspect ratios (apimart).

## Quick Start

```bash
# Google (default)
export GOOGLE_API_KEY="your-key"
bun scripts/main.ts generate --prompt "A cat in watercolor style" --outdir ./images

# OpenAI
export OPENAI_API_KEY="sk-..."
bun scripts/main.ts generate --provider openai --prompt "A cozy alpine cabin" --outdir ./images

# Image-to-image (reference, both providers)
bun scripts/main.ts generate --prompt "Make it blue" --ref source.png --outdir ./images

# Edit with mask (OpenAI only)
bun scripts/main.ts generate --provider openai \
  --prompt "Replace background with sunset" \
  --edit photo.png --mask mask.png --outdir ./images
```

## Capability Matrix

| Flag / Feature | Google | OpenAI | apimart | Notes |
|---|---|---|---|---|
| `--prompt` | yes | yes | yes | |
| `--ref <path>` | yes | yes | yes (auto-uploads to apimart) | Google: inlineData; OpenAI: image[] in /edits; apimart: uploads via `/v1/uploads/images` and submits the returned 72h URL |
| `--edit <path>` | yes (fallback) | yes (native) | yes | Google treats as ref[0]; OpenAI routes to /edits; apimart sends as `image_urls[0]` |
| `--mask <path>` | throws | yes (needs --edit or --ref) | yes | apimart accepts mask via the `mask_url` field |
| `--ar` | yes (7) | yes (7) | yes (13) | google/openai accept 7 values; apimart accepts the 6 extras (5:4, 4:5, 2:1, 1:2, 21:9, 9:21) too |
| `--resolution 1k\|2k\|4k` | 1k, 2k | 1k, 2k | 1k, 2k, 4k | apimart 4K is the only path; google/openai reject `4k` via validateRequest |
| `--resolution 4k` ar restriction | n/a | n/a | 16:9, 9:16, 2:1, 1:2, 21:9, 9:21 only | apimart rejects 4k + the 7 standard ar values |
| `--detail auto\|low\|medium\|high` | ignored | passed through | passed through (`quality` field) | gpt-image-2 native; Gemini ignores |
| `--chain` | yes | throws | throws | apimart is stateless/async |
| `--character` | yes | realtime only | yes (sha256 cache dedupes refs across prompts) | character refs uploaded once per unique hash |
| `batch submit` | yes | text-only | throws | apimart submit/poll is already async — no batch discount, so `batch` subcommands all throw friendly does-not-support |
| `batch submit --async` | yes | yes | n/a | use `--provider apimart` realtime instead |
| Batch with refs/edit/mask/character | yes | throws | n/a | OpenAI batch is text-only by design (YAGNI) |
| Transparent background | no | no | no | gpt-image-2 doesn't support background=transparent |
| HTTP proxy support | yes | text-only | text-only (refs require disabling proxy) | apimart upload uses multipart, same constraint as OpenAI edit/batch — fail-fast with a clear error if proxy is set |

## Environment Variables

Google provider:
- `GOOGLE_API_KEY` or `GEMINI_API_KEY` (required)
- `GOOGLE_BASE_URL` (default: https://generativelanguage.googleapis.com)
- `GOOGLE_IMAGE_MODEL` (default: gemini-3.1-flash-image-preview)

OpenAI provider:
- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (default: https://api.openai.com)
- `OPENAI_IMAGE_MODEL` (default: gpt-image-2)

apimart provider (China gateway for gpt-image-2):
- `APIMART_API_KEY` (required)
- `APIMART_BASE_URL` (default: https://api.apimart.ai)
- `APIMART_IMAGE_MODEL` (default: gpt-image-2-official)

## Commands

### generate — Realtime Image Generation

```bash
bun scripts/main.ts generate [options]
```

#### Single prompt

```bash
bun scripts/main.ts generate --prompt "A sunset over mountains" --outdir ./images
bun scripts/main.ts generate --prompt "A landscape" --ar 16:9 --resolution 2k --detail high --outdir ./images
```

#### Multiple prompts (sequential)

```bash
bun scripts/main.ts generate --prompts prompts.json --outdir ./images
```

`prompts.json`:

```json
[
  { "prompt": "A sunset over mountains", "ar": "16:9" },
  { "prompt": "A cat portrait", "resolution": "2k", "detail": "high" },
  { "prompt": "Edit this photo", "ref": ["base.png"] }
]
```

Per-task fields override global CLI flags. Paths in `ref` resolve relative to the JSON file's directory. The legacy `quality` field is rejected — see [Migration](#migration---quality---resolution--detail).

#### Character profile

Inject a reusable character bible into every prompt. Works with both single and multiple prompts.

```bash
bun scripts/main.ts generate --prompt "standing in a garden" --character model-a.json --outdir ./images
bun scripts/main.ts generate --prompts prompts.json --character model-a.json --outdir ./images
```

`model-a.json`:

```json
{
  "name": "model-A",
  "description": "25-year-old Asian woman, oval face, high cheekbones, small rounded chin, wide-set hazel eyes, black shoulder-length straight hair, 165cm, slim build, fair skin.",
  "negative": "Do not change facial proportions, eye color, hair length.",
  "references": ["./refs/front.png", "./refs/side.png"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | For logging/debugging, not injected into prompt |
| `description` | Yes | Identity description, prepended to every prompt |
| `negative` | No | Hard constraints, appended after description |
| `references` | No | Reference images, resolved relative to JSON file directory |

Prompt injection order: `{description} {negative} {original_prompt}`

Character references are prepended before `--ref` and prompts.json `ref` entries (higher priority as identity anchors). Duplicate paths are automatically deduplicated.

#### Chain mode (character consistency)

Star-anchored multi-turn: the first generated image becomes the visual anchor for all subsequent requests. Requires `--prompts` with 2+ prompts.

```bash
bun scripts/main.ts generate --prompts prompts.json --chain --outdir ./images
```

Best consistency: combine `--character` and `--chain`:

```bash
bun scripts/main.ts generate --prompts prompts.json --character model-a.json --chain --outdir ./images
```

How it works:
- Task 1: generates independently, result becomes the anchor
- Task 2..N: each request replays the anchor (first prompt + model response including `thoughtSignature`) plus the current prompt
- Payload size is fixed per request (star pattern, not sequential accumulation)

Chain mode behavior:
- First image must return exactly 1 image, otherwise chain aborts
- Subsequent image failures are skipped (logged), chain continues
- `--chain` with single `--prompt` is silently ignored (nothing to chain)
- `--chain` with `batch` prints a warning and is ignored (batch requests are independent)

Character refs in chain mode:
- Character references are only sent in the first request (already in the anchor)
- Character description is injected in every prompt (reinforces identity)
- Task-specific refs (from prompts.json `ref`) are sent in the current request

### batch — Batch Image Generation (50% cost savings)

```bash
bun scripts/main.ts batch <subcommand> [args] [options]
```

#### Submit a batch

```bash
# Synchronous (wait for completion)
bun scripts/main.ts batch submit prompts.json --outdir ./images

# Asynchronous (return job ID immediately)
bun scripts/main.ts batch submit prompts.json --outdir ./images --async

# With character profile
bun scripts/main.ts batch submit prompts.json --character model-a.json --outdir ./images
```

Note: character references are duplicated as base64 in each batch task. The CLI estimates total payload and errors if it would exceed the 20MB inline limit.

#### Check status

```bash
bun scripts/main.ts batch status <jobId>
```

#### Fetch results (async jobs)

```bash
bun scripts/main.ts batch fetch <jobId> --outdir ./images
```

#### List all jobs

```bash
bun scripts/main.ts batch list
```

#### Cancel a job

```bash
bun scripts/main.ts batch cancel <jobId>
```

## Options

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--prompt` | | Single prompt text | |
| `--prompts` | | Path to prompts.json | |
| `--model` | `-m` | Model ID | `gemini-3.1-flash-image-preview` |
| `--ar` | | Aspect ratio | `1:1` |
| `--resolution` | | `1k` / `2k` / `4k` | `2k` |
| `--detail` | | `auto` / `low` / `medium` / `high` | `high` |
| `--ref` | | Reference image path(s), repeatable | |
| `--character` | | Character profile JSON path | |
| `--chain` | | Enable star-anchored chain mode (realtime only) | `false` |
| `--outdir` | `-o` | Output directory | `.` |
| `--json` | | JSON output mode | `false` |
| `--async` | | Async batch submission | `false` |

Aspect ratio options (CLI accepts 13 values): `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3` (google + openai), plus `5:4`, `4:5`, `2:1`, `1:2`, `21:9`, `9:21` (apimart-only — google + openai reject these via `validateRequest`).

## Supported Models

| Model | Realtime | Batch | Notes |
|-------|----------|-------|-------|
| `gemini-2.5-flash-image` | Yes | Yes | GA |
| `gemini-3.1-flash-image-preview` | Yes | Yes | Default, preview |
| `gemini-3-pro-image-preview` | Yes | Yes | Preview |
| `gpt-image-2` (OpenAI direct) | Yes | Yes | text-only batch |
| `gpt-image-2-official` (apimart) | Yes | No (apimart batch is rejected — submit/poll is already async) | China gateway, native 4K, 13-value ar |

The `--model` flag accepts any model ID. The above are verified as of 2026-04-13.

## apimart Provider (China gateway)

apimart is a China-domestic gateway for OpenAI gpt-image-2 with native 4K, extended
aspect ratios (13 values), and a fully async task model. Use it when you need 4K
output, the apimart-only ar values (5:4, 4:5, 2:1, 1:2, 21:9, 9:21), or want to
avoid the cross-border proxy hop required for direct OpenAI access from China.

### Configuration

```bash
export APIMART_API_KEY="..."           # required
# optional:
export APIMART_BASE_URL="https://api.apimart.ai"
export APIMART_IMAGE_MODEL="gpt-image-2-official"
```

### Usage

```bash
# Text-to-image
bun scripts/main.ts generate --provider apimart --prompt "..." --resolution 2k --detail high

# 4K (only with ar 16:9, 9:16, 2:1, 1:2, 21:9, 9:21)
bun scripts/main.ts generate --provider apimart --prompt "..." --resolution 4k --ar 16:9

# Image-to-image (refs auto-uploaded, return 72h URLs)
bun scripts/main.ts generate --provider apimart --prompt "..." --ref a.png

# Edit with mask
bun scripts/main.ts generate --provider apimart --prompt "..." --edit photo.png --mask m.png

# Apimart-only aspect ratios
bun scripts/main.ts generate --provider apimart --prompt "..." --ar 21:9
```

### Notes

- **Async polling**: image generation is async (submit → poll). Polling uses 12s
  initial wait, 3s interval, 180s timeout. On timeout the error message includes
  the `task_id` — check the apimart console manually if the task subsequently
  completes; results are retrievable for 72h.
- **Image upload URLs**: refs/edit/mask are uploaded to apimart's own
  `/v1/uploads/images` and the returned URLs are valid for 72h. apimart manages
  expiration; jdy-imagine does not need cleanup. URLs are reused across the
  same run via a sha256-keyed cache, so the same content uploads exactly once
  even when used by many prompts.
- **HTTPS_PROXY**: apimart upload uses multipart and does NOT route through
  HTTP proxy (same constraint as OpenAI direct). Disable proxy when using
  `--provider apimart` with image inputs.
- **No batch / no chain**: apimart does not implement batch (no cost benefit)
  or chain (API is async/stateless). These commands throw with a friendly
  message pointing to alternatives.

## Configuration

### API Key

Set via environment variable:

```bash
export GOOGLE_API_KEY="your-key"
# or
export GEMINI_API_KEY="your-key"
```

Or create a `.env` file (searched in order):
1. `<cwd>/.jdy-imagine/.env`
2. `~/.jdy-imagine/.env`

### EXTEND.md

Override defaults via YAML front matter (searched in order):
1. `<cwd>/.jdy-imagine/EXTEND.md`
2. `~/.config/jdy-imagine/EXTEND.md`
3. `~/.jdy-imagine/EXTEND.md`

```yaml
---
default_provider: google
default_resolution: 2k
default_detail: high
default_ar: "1:1"
---
```

(`default_model` is intentionally omitted; see the [advisory](#extendmd-default_model-advisory) below.)

### Priority

CLI flags > EXTEND.md > Environment variables > Built-in defaults

## Output

Files are saved as `{outdir}/{NNN}-{slug}.png` where NNN is a zero-padded sequence number and slug is derived from the prompt (first 4 tokens, lowercase, max 40 chars).

Examples:
- `001-a-sunset-over-mountains.png`
- `002-一只可爱的猫在花园里.png`

Multiple images from one prompt get `-a`, `-b` suffixes. Collisions get `-2`, `-3` suffixes.

## Migration: --quality → --resolution + --detail

The single `--quality` flag has been split into two independent dimensions to match what providers actually expose:

- `--resolution {1k,2k,4k}` — output pixel resolution (was the dimensional half of `--quality 2k`)
- `--detail {auto,low,medium,high}` — quality/sharpness tier (was the OpenAI-mapped half of `--quality 2k`; Gemini ignores)

CLI migration:

| Old | New |
|---|---|
| `--quality normal` | `--resolution 1k --detail medium` |
| `--quality 2k` | `--resolution 2k --detail high` |

EXTEND.md migration:

```yaml
# Old
default_quality: 2k
# New
default_resolution: 2k
default_detail: high
```

prompts.json migration:

```json
// Old
{ "prompt": "...", "quality": "2k" }
// New
{ "prompt": "...", "resolution": "2k", "detail": "high" }
```

Any leftover `quality` field (CLI flag / EXTEND.md `default_quality` / prompts.json) triggers a migration error pointing back to this section.

### EXTEND.md `default_model` advisory

`default_model` in `EXTEND.md` is **provider-agnostic** — it applies regardless of which `--provider` you pick at runtime. With multiple providers having non-overlapping model namespaces (`gemini-3.1-...` / `gpt-image-2` / `gpt-image-2-official`), shipping `default_model: gemini-3.1-flash-image-preview` would silently leak Gemini's model name into other providers. Therefore `EXTEND.md.example` no longer ships a `default_model:` line.

Override patterns:

| Goal | Mechanism |
|---|---|
| Permanent custom model for one provider | `<PROVIDER>_IMAGE_MODEL` env var |
| One-off custom model | `--model <id>` CLI flag |
| Cross-provider override (rare) | keep `default_model` in EXTEND.md (will apply to every `--provider`) |

Priority order: `--model` > `EXTEND.md default_model` > `<PROVIDER>_IMAGE_MODEL` env > provider's built-in default.

## prompts.json Format

```json
[
  { "prompt": "A sunset over mountains", "ar": "16:9" },
  { "prompt": "A cat portrait", "resolution": "2k", "detail": "high" },
  { "prompt": "Edit this", "ref": ["base.png", "overlay.png"] }
]
```

Per-task fields: `prompt` (required), `ar`, `resolution`, `detail`, `ref`. All non-prompt fields are validated against the same allowlists `--ar` / `--resolution` / `--detail` enforce. Legacy `quality` field is rejected with migration guidance.

All fields except `prompt` are optional and override global CLI flags.
