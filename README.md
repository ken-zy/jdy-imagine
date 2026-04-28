# jdy-imagine

AI image generation plugin for Claude Code. Supports both **Google Gemini** and **OpenAI gpt-image-2**. Realtime + Batch API, character consistency, chain mode (Gemini), edit with mask (OpenAI).

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

| Flag / Feature | Google | OpenAI | Notes |
|---|---|---|---|
| `--prompt` | yes | yes | |
| `--ref <path>` | yes | yes | Google: inlineData; OpenAI: image[] in /edits |
| `--edit <path>` | yes (fallback) | yes (native) | Google treats as ref[0]; OpenAI routes to /edits |
| `--mask <path>` | throws | yes (needs --edit or --ref) | |
| `--ar` | yes | yes | OpenAI uses fixed SIZE_TABLE mapping |
| `--quality normal\|2k` | yes | yes | OpenAI: normal→medium, 2k→high |
| `--chain` | yes | throws | OpenAI image API is stateless |
| `--character` | yes | realtime only | Blocked in OpenAI batch (refs would be lost) |
| `batch submit` | yes | text-only | OpenAI uses /v1/batches with 50% discount |
| `batch submit --async` | yes | yes | |
| Batch with refs/edit/mask/character | yes | throws | OpenAI batch is text-only by design (YAGNI) |
| 4K / arbitrary size | no | not exposed | OpenAI 4K is server-supported but not in SIZE_TABLE |
| Transparent background | no | no | gpt-image-2 doesn't support background=transparent |

## Environment Variables

Google provider:
- `GOOGLE_API_KEY` or `GEMINI_API_KEY` (required)
- `GOOGLE_BASE_URL` (default: https://generativelanguage.googleapis.com)
- `GOOGLE_IMAGE_MODEL` (default: gemini-3.1-flash-image-preview)

OpenAI provider:
- `OPENAI_API_KEY` (required)
- `OPENAI_BASE_URL` (default: https://api.openai.com)
- `OPENAI_IMAGE_MODEL` (default: gpt-image-2)

## Commands

### generate — Realtime Image Generation

```bash
bun scripts/main.ts generate [options]
```

#### Single prompt

```bash
bun scripts/main.ts generate --prompt "A sunset over mountains" --outdir ./images
bun scripts/main.ts generate --prompt "A landscape" --ar 16:9 --quality 2k --outdir ./images
```

#### Multiple prompts (sequential)

```bash
bun scripts/main.ts generate --prompts prompts.json --outdir ./images
```

`prompts.json`:

```json
[
  { "prompt": "A sunset over mountains", "ar": "16:9" },
  { "prompt": "A cat portrait", "quality": "2k" },
  { "prompt": "Edit this photo", "ref": ["base.png"] }
]
```

Per-task fields override global CLI flags. Paths in `ref` resolve relative to the JSON file's directory.

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
| `--quality` | | `normal` / `2k` | `2k` |
| `--ref` | | Reference image path(s), repeatable | |
| `--character` | | Character profile JSON path | |
| `--chain` | | Enable star-anchored chain mode (realtime only) | `false` |
| `--outdir` | `-o` | Output directory | `.` |
| `--json` | | JSON output mode | `false` |
| `--async` | | Async batch submission | `false` |

Aspect ratio options: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`

## Supported Models

| Model | Realtime | Batch | Notes |
|-------|----------|-------|-------|
| `gemini-2.5-flash-image` | Yes | Yes | GA |
| `gemini-3.1-flash-image-preview` | Yes | Yes | Default, preview |
| `gemini-3-pro-image-preview` | Yes | Yes | Preview |

The `--model` flag accepts any model ID. The above are verified as of 2026-04-13.

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
default_model: gemini-3.1-flash-image-preview
default_quality: 2k
default_ar: "1:1"
---
```

### Priority

CLI flags > EXTEND.md > Environment variables > Built-in defaults

## Output

Files are saved as `{outdir}/{NNN}-{slug}.png` where NNN is a zero-padded sequence number and slug is derived from the prompt (first 4 tokens, lowercase, max 40 chars).

Examples:
- `001-a-sunset-over-mountains.png`
- `002-一只可爱的猫在花园里.png`

Multiple images from one prompt get `-a`, `-b` suffixes. Collisions get `-2`, `-3` suffixes.

## prompts.json Format

```json
[
  { "prompt": "A sunset over mountains", "ar": "16:9" },
  { "prompt": "A cat portrait", "quality": "2k" },
  { "prompt": "Edit this", "ref": ["base.png", "overlay.png"] }
]
```

All fields except `prompt` are optional and override global CLI flags.
