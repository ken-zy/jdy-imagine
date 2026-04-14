# Character Consistency Design Spec

## Overview

Add character consistency support to jdy-imagine via two complementary mechanisms:

1. **Character Profile (`--character`)** — inject a reusable character bible (description + negative constraints + reference images) into every prompt. Works in both realtime and batch modes.
2. **Chain Mode (`--chain`)** — multi-turn context with star anchoring: the first generated image becomes the visual anchor for all subsequent requests. Realtime mode only.

Combined, these provide the best consistency: character bible locks semantic identity, chain mode locks visual identity.

## Character Profile

### Format: `character.json`

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
| `name` | No | Character name for logging/debugging, not injected into prompt |
| `description` | Yes | Identity description, prepended to every prompt |
| `negative` | No | Hard constraints / negative instructions, appended after description |
| `references` | No | Reference image paths, resolved relative to JSON file directory |

### Prompt Injection Order

```
{character.description} {character.negative} {original_prompt}
```

### Reference Merge Rules

- Character references are prepended before CLI `--ref` and prompts.json `ref` entries
- Character refs have higher priority as identity anchors (appear first in API parts)
- Deduplication: if the same file path appears in both character and task refs, include it only once

### Applicability

| Mode | description+negative | references |
|------|---------------------|------------|
| Realtime | Injected into prompt | Merged into refs |
| Batch | Injected into prompt | Merged into refs |

Character profile is fully transparent to both modes.

### Module: `scripts/lib/character.ts`

```typescript
interface CharacterProfile {
  name?: string;
  description: string;
  negative?: string;
  references: string[];  // resolved to absolute paths
}

function loadCharacter(filePath: string): CharacterProfile;
function applyCharacter(
  prompt: string,
  refs: string[],
  character: CharacterProfile,
): { prompt: string; refs: string[] };
```

`loadCharacter`: reads JSON, validates `description` is present, resolves reference paths relative to the JSON file's directory. Throws on missing file or missing `description`.

`applyCharacter`: prepends `description` + `negative` to prompt, merges character references before task refs (with dedup).

## Chain Mode

### Concept: Star Anchoring

Instead of sequential chaining (each request sees all prior turns, causing context growth and drift), chain mode uses star anchoring: all subsequent requests reference only the first generated image.

```
Task 1: generate independently → image_1 (anchor)
Task 2: [prompt_1, image_1, prompt_2] → image_2
Task 3: [prompt_1, image_1, prompt_3] → image_3
...
```

Payload size is fixed per request (one extra image), and consistency is stable (no accumulated drift).

### ConversationTurn Type

```typescript
// Added to types.ts
interface ConversationTurn {
  role: "user" | "model";
  parts: Array<{
    text?: string;
    imageData?: { data: string; mimeType: string };
  }>;
}
```

`GenerateRequest` gains an optional field:

```typescript
interface GenerateRequest {
  // ...existing fields
  history?: ConversationTurn[];
}
```

### Anchor Construction

After the first image is generated successfully:

```typescript
anchorHistory = [
  {
    role: "user",
    parts: [{ text: firstTask.prompt }],  // text only, no binary refs
  },
  {
    role: "model",
    parts: [{
      imageData: {
        data: base64(firstResult.images[0].data),
        mimeType: firstResult.images[0].mimeType,
      },
    }],
  },
];
```

The anchor's user turn contains only the text prompt — ref images are not stored in history. When `buildRealtimeRequestBody` constructs the actual API request, it re-reads ref images from disk and inserts them as `inlineData` parts in the first user turn. This avoids duplicating large binary data in memory while ensuring the API request includes the full visual context. The model turn contains the first generated image as base64.

### Request Construction with History

When `req.history` is present, `buildRealtimeRequestBody` in `google.ts` constructs multi-turn contents:

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "inlineData": { "data": "<ref_base64>", "mimeType": "image/png" } },
        { "text": "character desc + first prompt" }
      ]
    },
    {
      "role": "model",
      "parts": [
        { "inlineData": { "data": "<anchor_image_base64>", "mimeType": "image/png" } }
      ]
    },
    {
      "role": "user",
      "parts": [{ "text": "character desc + current prompt" }]
    }
  ],
  "generationConfig": { "responseModalities": ["IMAGE"], "imageConfig": { "imageSize": "2K" } }
}
```

Key details:
- Character refs (inlineData) only appear in the first user turn
- Character description is injected in every user turn (reinforces identity)
- The anchor model turn contains only the generated base image

### Error Handling

| Scenario | Behavior |
|----------|----------|
| First image fails (safety/no-image) | Chain aborted, exit with error |
| Subsequent image fails | Skip task, log warning, continue to next |
| `--chain` without `--prompts` | Ignored (single prompt, nothing to chain) |
| `--chain` with `batch` | Warning printed, flag ignored |

### Payload Size

Star mode per-request overhead = base anchor image base64 size. At 2K resolution, PNG is approximately 2-4MB base64. Combined with character refs and prompt text, a single request totals approximately 5-8MB — well within Gemini's per-request limit.

## CLI Changes

### New Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--chain` | boolean | false | Enable star-anchored chain mode (realtime only) |
| `--character` | string | — | Path to character profile JSON |

### Usage Examples

```bash
# Character only (realtime + batch)
bun scripts/main.ts generate --prompts prompts.json --character model-a.json

# Chain only (realtime)
bun scripts/main.ts generate --prompts prompts.json --chain

# Character + Chain (best consistency)
bun scripts/main.ts generate --prompts prompts.json --character model-a.json --chain

# Batch + Character (chain auto-ignored)
bun scripts/main.ts batch submit prompts.json --character model-a.json
```

## Files Changed

| File | Change |
|------|--------|
| `scripts/lib/character.ts` | **New** — CharacterProfile type, loadCharacter, applyCharacter |
| `scripts/lib/args.ts` | Add `--chain` and `--character` flag parsing |
| `scripts/providers/types.ts` | Add ConversationTurn type, history field to GenerateRequest |
| `scripts/providers/google.ts` | buildRealtimeRequestBody supports history → multi-turn contents |
| `scripts/commands/generate.ts` | Chain orchestration + character injection |
| `scripts/commands/batch.ts` | Character injection + chain warning |
| `scripts/main.ts` | Pass new flags through |

## What's NOT in This Version

- Sequential chain mode (accumulated history) — star mode only
- Group-based chaining within prompts.json
- Automatic anchor quality evaluation (user must verify first image manually)
- Chain mode for batch (API limitation)
- Character profile in EXTEND.md (always explicit via `--character` flag)
