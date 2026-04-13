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
