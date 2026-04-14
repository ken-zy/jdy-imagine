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

Character profile is transparent to both modes. However, batch mode with character references compounds the existing 20MB inline payload limit: each task gets character refs duplicated as base64. The CLI must estimate total payload before submission and error early if character refs + task refs + prompts would exceed the limit. The error message should suggest reducing the number of tasks per batch or removing character references from large batches.

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

### Architecture: Provider-Internal Chain State

Chain state is **not** exposed in the provider-level `GenerateRequest` interface. Multi-turn conversation is a Google-specific concern that requires preserving raw API response parts (including `thoughtSignature` — see below). Putting a generic `history` field in the Provider interface would be a premature abstraction with the wrong shape.

Instead, chain mode is implemented as follows:

1. **`generate.ts`** orchestrates the chain: calls `provider.generate()` for the first task, then calls a new Google-specific method `provider.generateChained()` for subsequent tasks.
2. **`google.ts`** owns the chain state internally: it preserves the raw first-turn request parts and raw model response parts (including `thoughtSignature`), and constructs multi-turn `contents` from them.
3. **`Provider` interface** gains one optional method: `generateChained?(req: GenerateRequest, anchor: ChainAnchor): Promise<GenerateResult>`, where `ChainAnchor` is an opaque type returned by the provider.

### Thought Signatures

Gemini 3.x models return `thoughtSignature` fields on model response parts. These are cryptographically signed snapshots of the model's reasoning state. For multi-turn image editing, **all thought signatures from the previous model turn must be sent back verbatim** — missing them causes a 400 error.

Current `parseGenerateResponse` strips all part-level metadata, keeping only `images[]` and `textParts[]`. For chain mode, the Google provider must additionally preserve the **raw model response parts** (the entire `candidates[0].content` object) to replay them in subsequent requests.

### Chain State Type (Google-internal)

```typescript
// In google.ts, NOT in types.ts
interface GoogleChainAnchor {
  // Raw first-turn user parts as sent to the API (includes inlineData refs + text)
  firstUserParts: Array<Record<string, unknown>>;
  // Raw model response content from first turn (includes thoughtSignature, inlineData, text)
  modelContent: { role: string; parts: Array<Record<string, unknown>> };
}
```

### Opaque Anchor in Provider Interface

```typescript
// In types.ts — opaque handle, provider-specific internals hidden
type ChainAnchor = unknown;

interface Provider {
  // ...existing methods

  // Chain support (optional)
  generateChained?(req: GenerateRequest, anchor: ChainAnchor): Promise<GenerateResult>;
  createAnchor?(firstReq: GenerateRequest, rawResponse: unknown): ChainAnchor;
}
```

`generate.ts` calls `provider.generate()` for the first task, then `provider.createAnchor()` to capture the anchor from the raw response, then `provider.generateChained()` for subsequent tasks. The anchor is opaque to the orchestrator.

### Raw Response Preservation

To support `createAnchor`, the Google provider's `generate()` method must return the raw API response alongside the parsed `GenerateResult`. Implementation approach: `generate()` continues to return `GenerateResult` as before. A separate internal method captures the raw response for anchor creation. Specifically:

```typescript
// Google provider internal
async function generateWithRaw(req: GenerateRequest): Promise<{
  result: GenerateResult;
  rawResponse: unknown;  // full API response JSON
}>;
```

`generate()` wraps `generateWithRaw()` and returns only `result`. When chain mode is active, `generate.ts` calls `generateWithRaw()` directly for the first task (via a provider-specific cast), then passes `rawResponse` to `createAnchor()`.

Alternative (cleaner): `createAnchor` is called with the `GenerateRequest` and the provider re-sends a lightweight probe. But this wastes an API call. The `generateWithRaw` approach is preferred despite the slightly awkward cast.

### Request Construction with Anchor

When `generateChained` is called, Google provider constructs multi-turn contents:

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
        { "thoughtSignature": "<base64_signature>" },
        { "inlineData": { "data": "<anchor_image_base64>", "mimeType": "image/png" } },
        { "thoughtSignature": "<base64_signature_2>" }
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
- The model turn is the **raw preserved content** from the first generation, including all `thoughtSignature` fields in their original positions
- Character refs (inlineData) only appear in the first user turn (from `firstUserParts`)
- Character description is injected in every user turn (reinforces identity)
- The first user turn is reconstructed from `GoogleChainAnchor.firstUserParts`

### First Image Guard

Chain mode requires exactly one image from the first generation to establish a clear anchor. If the first task returns zero images (safety block, text-only response) or multiple images, chain mode aborts with an error:

- Zero images: `"Chain aborted: first image generation failed (safety/no-image)"`
- Multiple images: `"Chain aborted: first task returned multiple images, cannot determine anchor. Use a more specific prompt for the first task."`

### Error Handling

| Scenario | Behavior |
|----------|----------|
| First image fails (safety/no-image) | Chain aborted, exit with error |
| First image returns multiple images | Chain aborted, exit with error |
| Subsequent image fails | Skip task, log warning, continue to next |
| `--chain` without `--prompts` | Ignored (single prompt, nothing to chain) |
| `--chain` with `batch` | Warning printed, flag ignored |

### Payload Size

Star mode per-request overhead = raw anchor model content size (includes base64 image + thought signatures). At 2K resolution, this is approximately 3-5MB. Combined with character refs and prompt text, a single request totals approximately 6-10MB — within Gemini's per-request limit but larger than non-chain requests.

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
| `scripts/providers/types.ts` | Add `ChainAnchor` opaque type, `generateChained?` and `createAnchor?` optional methods to Provider |
| `scripts/providers/google.ts` | Add `GoogleChainAnchor` type, `generateWithRaw`, implement `generateChained` and `createAnchor`; preserve raw response parts including `thoughtSignature` |
| `scripts/commands/generate.ts` | Chain orchestration (first-image guard, anchor creation, chained generation) + character injection |
| `scripts/commands/batch.ts` | Character injection + `--chain` warning + payload estimation guardrail for character refs |
| `scripts/main.ts` | Pass new flags through |

## What's NOT in This Version

- Sequential chain mode (accumulated history) — star mode only
- Group-based chaining within prompts.json
- Automatic anchor quality evaluation (user must verify first image manually)
- Chain mode for batch (API limitation — each batch request is independent)
- Character profile in EXTEND.md (always explicit via `--character` flag)
- Batch File API submission (would alleviate 20MB limit with character refs)
