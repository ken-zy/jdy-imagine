---
name: jdy-imagine
description: AI image generation via Google Gemini, OpenAI gpt-image-2, and apimart (China gateway). Text-to-image, image-to-image, edit with mask, batch generation at 50% cost (Google/OpenAI), 4K + 13-value ar (apimart).
---

# jdy-imagine

AI image generation plugin for Claude Code. Supports Google Gemini, OpenAI gpt-image-2, and apimart (China-domestic gateway for gpt-image-2 with native 4K + 13-value ar).

## Usage

### Text-to-image
```bash
bun scripts/main.ts generate --prompt "A cat in watercolor style" --outdir ./images
bun scripts/main.ts generate --provider openai --prompt "A cat in watercolor style" --outdir ./images
```

### Image-to-image (reference)
```bash
bun scripts/main.ts generate --prompt "Make it blue" --ref source.png --outdir ./images
```

### Edit (with mask, OpenAI / apimart)
```bash
bun scripts/main.ts generate --provider openai \
  --prompt "Replace background" --edit photo.png --mask mask.png --outdir ./images
```

### apimart (China gateway, 4K, extended ar)
```bash
# Native 4K (only ar 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21)
bun scripts/main.ts generate --provider apimart \
  --prompt "..." --resolution 4k --ar 16:9 --outdir ./images

# Apimart-only aspect ratios (5:4, 4:5, 2:1, 1:2, 21:9, 9:21)
bun scripts/main.ts generate --provider apimart --prompt "..." --ar 21:9 --outdir ./images
```

### Batch generation (50% cost savings)
```bash
bun scripts/main.ts batch submit prompts.json --outdir ./images
bun scripts/main.ts batch submit text-only-prompts.json --provider openai --outdir ./images
```

(Note: `command` must come before flags. `--provider openai batch submit ...` will not parse — `--provider` would be consumed as a flag and `command` would be empty.)

### Options
- `--provider`: `google` (default), `openai`, or `apimart`
- `--model`, `-m`: Model ID (provider default if not specified)
- `--ar`: Aspect ratio. CLI accepts 13 values: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3` (google + openai), plus `5:4`, `4:5`, `2:1`, `1:2`, `21:9`, `9:21` (apimart-only when added — google + openai reject these via validateRequest)
- `--resolution`: `1k` / `2k` / `4k` (default: `2k`; `4k` apimart-only when added — google + openai reject)
- `--detail`: `auto` / `low` / `medium` / `high` (default: `high`; OpenAI passes through, Gemini ignores)
- `--ref`: Reference image path(s) — works in both providers
- `--edit`: Edit target image path — Google: same as --ref; OpenAI: routes to /edits
- `--mask`: Mask image path — OpenAI / apimart, requires --edit or --ref (Google rejects)
- `--outdir`, `-o`: Output directory (default: .)
- `--json`: JSON output mode

### Configuration
- Google: `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- apimart: `APIMART_API_KEY`

Or create `.jdy-imagine/.env`.

### Capability matrix

| Feature | Google | OpenAI | apimart |
|---|---|---|---|
| `--ref` | yes (inlineData) | yes (routes to /edits) | yes (auto-uploads to /v1/uploads/images, 72h URL) |
| `--edit` | falls back to --ref | yes (native) | yes (image_urls[0]) |
| `--mask` | not supported | yes (needs --edit or --ref) | yes (mask_url field) |
| `--chain` | yes | not supported | not supported |
| `--character` | yes | yes (realtime); blocked in OpenAI batch | yes (sha256 cache dedupes uploads) |
| batch submit | yes | text-only (no refs/edit/mask/character) | not supported (submit/poll already async) |
| 4K | no | not exposed | yes — only with ar 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21 |
| Extended ar (5:4, 4:5, 2:1, 1:2, 21:9, 9:21) | rejected | rejected | yes |
| HTTPS_PROXY | yes | text-only | text-only (refs require disabling proxy) |
