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

### Image-to-image (reference)
```bash
bun scripts/main.ts generate --prompt "Make it blue" --ref source.png --outdir ./images
```

### Edit (with mask, OpenAI only)
```bash
bun scripts/main.ts generate --provider openai \
  --prompt "Replace background" --edit photo.png --mask mask.png --outdir ./images
```

### Batch generation (50% cost savings)
```bash
bun scripts/main.ts batch submit prompts.json --outdir ./images
bun scripts/main.ts batch submit text-only-prompts.json --provider openai --outdir ./images
```

(Note: `command` must come before flags. `--provider openai batch submit ...` will not parse — `--provider` would be consumed as a flag and `command` would be empty.)

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
- Google: `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- OpenAI: `OPENAI_API_KEY`

Or create `.jdy-imagine/.env`.

### Capability matrix

| Feature | Google | OpenAI |
|---|---|---|
| `--ref` | yes | yes (routes to /edits) |
| `--edit` | falls back to --ref | yes (native) |
| `--mask` | not supported | yes (needs --edit or --ref) |
| `--chain` | yes | not supported |
| `--character` | yes | yes (realtime); blocked in OpenAI batch |
| batch submit | yes | text-only (no refs/edit/mask/character) |
| 4K / arbitrary size | no | not exposed (use --quality 2k) |
