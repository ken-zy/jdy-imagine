# Character Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--character` (character bible injection) and `--chain` (star-anchored multi-turn) to jdy-imagine for consistent character generation across multiple images.

**Architecture:** Character profile is a standalone module with two injection functions: `applyCharacterPrompt` (description+negative → prompt prefix, always applied) and `mergeCharacterRefs` (reference images → refs merge, skipped for chain tasks 2..N since character refs are already in the anchor's first user turn). Chain mode is Google-provider-internal: preserves raw API response parts including `thoughtSignature` for multi-turn replay. Provider interface gets opaque `ChainAnchor` + optional `generateAndAnchor`/`generateChained` methods — no hidden contracts.

**Tech Stack:** TypeScript, Bun, Google Gemini API (`generateContent` with multi-turn `contents`)

---

### Task 1: Character Profile Module — `scripts/lib/character.ts`

**Files:**
- Create: `scripts/lib/character.ts`
- Create: `scripts/lib/character.test.ts`

- [ ] **Step 1: Write failing tests for loadCharacter**

```typescript
// scripts/lib/character.test.ts
import { describe, test, expect } from "bun:test";
import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs } from "./character";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadCharacter", () => {
  test("loads valid character profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "char-"));
    const refPath = join(dir, "front.png");
    writeFileSync(refPath, Buffer.from([0x89, 0x50]));
    const charPath = join(dir, "char.json");
    writeFileSync(
      charPath,
      JSON.stringify({
        name: "model-A",
        description: "25-year-old woman, oval face",
        negative: "Do not change face",
        references: ["./front.png"],
      }),
    );
    const profile = loadCharacter(charPath);
    expect(profile.name).toBe("model-A");
    expect(profile.description).toBe("25-year-old woman, oval face");
    expect(profile.negative).toBe("Do not change face");
    expect(profile.references).toHaveLength(1);
    expect(profile.references[0]).toBe(refPath); // resolved to absolute
  });

  test("throws on missing description", () => {
    const dir = mkdtempSync(join(tmpdir(), "char-"));
    const charPath = join(dir, "char.json");
    writeFileSync(charPath, JSON.stringify({ name: "bad" }));
    expect(() => loadCharacter(charPath)).toThrow("description");
  });

  test("throws on missing file", () => {
    expect(() => loadCharacter("/nonexistent/char.json")).toThrow();
  });

  test("defaults references to empty array", () => {
    const dir = mkdtempSync(join(tmpdir(), "char-"));
    const charPath = join(dir, "char.json");
    writeFileSync(
      charPath,
      JSON.stringify({ description: "a woman" }),
    );
    const profile = loadCharacter(charPath);
    expect(profile.references).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/lib/character.test.ts`
Expected: FAIL — module `./character` not found

- [ ] **Step 3: Write failing tests for applyCharacterPrompt and mergeCharacterRefs**

Append test cases to `scripts/lib/character.test.ts` (imports already present from Step 1):

```typescript
describe("applyCharacterPrompt", () => {
  test("prepends description and negative to prompt", () => {
    const result = applyCharacterPrompt("wearing red dress", {
      description: "25-year-old woman",
      negative: "Do not change face",
      references: [],
    });
    expect(result).toBe(
      "25-year-old woman Do not change face wearing red dress",
    );
  });

  test("prepends description only when no negative", () => {
    const result = applyCharacterPrompt("wearing red dress", {
      description: "25-year-old woman",
      references: [],
    });
    expect(result).toBe("25-year-old woman wearing red dress");
  });
});

describe("mergeCharacterRefs", () => {
  test("merges character refs before task refs", () => {
    const result = mergeCharacterRefs(["/task/ref.png"], {
      description: "desc",
      references: ["/char/front.png", "/char/side.png"],
    });
    expect(result).toEqual([
      "/char/front.png",
      "/char/side.png",
      "/task/ref.png",
    ]);
  });

  test("deduplicates refs by absolute path", () => {
    const result = mergeCharacterRefs(["/shared/ref.png"], {
      description: "desc",
      references: ["/shared/ref.png", "/char/side.png"],
    });
    expect(result).toEqual(["/shared/ref.png", "/char/side.png"]);
  });
});
```

- [ ] **Step 4: Implement character.ts**

```typescript
// scripts/lib/character.ts
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

export interface CharacterProfile {
  name?: string;
  description: string;
  negative?: string;
  references: string[]; // resolved to absolute paths
}

export function loadCharacter(filePath: string): CharacterProfile {
  if (!existsSync(filePath)) {
    throw new Error(`Character file not found: ${filePath}`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as {
    name?: string;
    description?: string;
    negative?: string;
    references?: string[];
  };
  if (!raw.description) {
    throw new Error(
      `Character file ${filePath} is missing required "description" field`,
    );
  }
  const dir = dirname(resolve(filePath));
  return {
    name: raw.name,
    description: raw.description,
    negative: raw.negative,
    references: (raw.references ?? []).map((r) => resolve(dir, r)),
  };
}

// Inject description + negative into prompt (always applied, all modes)
export function applyCharacterPrompt(
  prompt: string,
  character: CharacterProfile,
): string {
  const parts = [character.description];
  if (character.negative) parts.push(character.negative);
  parts.push(prompt);
  return parts.join(" ");
}

// Merge character refs before task refs with dedup (skipped for chain tasks 2..N)
export function mergeCharacterRefs(
  taskRefs: string[],
  character: CharacterProfile,
): string[] {
  const seen = new Set(character.references);
  const merged = [...character.references];
  for (const r of taskRefs) {
    if (!seen.has(r)) {
      seen.add(r);
      merged.push(r);
    }
  }
  return merged;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test scripts/lib/character.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/character.ts scripts/lib/character.test.ts
git commit -m "feat(character): add CharacterProfile module with loadCharacter, applyCharacterPrompt, and mergeCharacterRefs"
```

---

### Task 2: CLI Flag Parsing — `--chain` and `--character`

**Files:**
- Modify: `scripts/lib/args.ts:1-17` (ParsedArgs interface)
- Modify: `scripts/lib/args.ts:58-99` (flag parsing switch)
- Modify: `scripts/lib/args.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `scripts/lib/args.test.ts`:

```typescript
describe("--chain flag", () => {
  test("defaults to false", () => {
    const result = parseArgs(["generate", "--prompt", "test"]);
    expect(result.flags.chain).toBe(false);
  });

  test("sets chain to true", () => {
    const result = parseArgs(["generate", "--prompts", "p.json", "--chain"]);
    expect(result.flags.chain).toBe(true);
  });
});

describe("--character flag", () => {
  test("defaults to undefined", () => {
    const result = parseArgs(["generate", "--prompt", "test"]);
    expect(result.flags.character).toBeUndefined();
  });

  test("parses character path", () => {
    const result = parseArgs([
      "generate",
      "--prompt",
      "test",
      "--character",
      "model-a.json",
    ]);
    expect(result.flags.character).toBe("model-a.json");
  });

  test("works with batch command", () => {
    const result = parseArgs([
      "batch",
      "submit",
      "prompts.json",
      "--character",
      "char.json",
    ]);
    expect(result.flags.character).toBe("char.json");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/lib/args.test.ts`
Expected: FAIL — `chain` and `character` not in flags

- [ ] **Step 3: Modify args.ts — add flags to interface and parsing**

In `scripts/lib/args.ts`, update `ParsedArgs.flags` interface:

```typescript
export interface ParsedArgs {
  command: string;
  subcommand?: string;
  positional?: string;
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
    chain: boolean;       // NEW
    character?: string;   // NEW
  };
}
```

Update defaults in `parseArgs`:

```typescript
flags: {
  outdir: ".",
  json: false,
  async: false,
  chain: false,   // NEW
},
```

Add cases to the switch statement (before the `default` case):

```typescript
case "--chain":
  result.flags.chain = true;
  break;
case "--character":
  result.flags.character = nextVal(arg);
  break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/lib/args.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/args.ts scripts/lib/args.test.ts
git commit -m "feat(args): add --chain and --character flag parsing"
```

---

### Task 3: Provider Interface — ChainAnchor + Optional Methods

**Files:**
- Modify: `scripts/providers/types.ts`
- Modify: `scripts/providers/types.test.ts`

- [ ] **Step 1: Write failing test for ChainAnchor type**

Add to the existing imports in `scripts/providers/types.test.ts` (merge into existing `import type` line):

```typescript
import type { ChainAnchor, Provider } from "./types";
```

Then append test cases:

```typescript
describe("ChainAnchor type", () => {
  test("ChainAnchor is opaque (accepts any value)", () => {
    const anchor: ChainAnchor = { something: "provider-specific" };
    expect(anchor).toBeDefined();
  });
});

describe("Provider chain methods", () => {
  test("generateAndAnchor and generateChained are optional", () => {
    const minimalProvider: Provider = {
      name: "test",
      defaultModel: "test-model",
      generate: async () => ({ images: [], finishReason: "STOP" }),
    };
    expect(minimalProvider.generateAndAnchor).toBeUndefined();
    expect(minimalProvider.generateChained).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/providers/types.test.ts`
Expected: FAIL — `ChainAnchor` type not exported

- [ ] **Step 3: Add ChainAnchor and optional methods to types.ts**

Replace the entire `Provider` interface in `scripts/providers/types.ts` with:

```typescript
// Opaque handle for provider-specific chain state
export type ChainAnchor = unknown;

export interface Provider {
  name: string;
  defaultModel: string;

  // Realtime
  generate(req: GenerateRequest): Promise<GenerateResult>;

  // Chain support (optional — provider-specific)
  // First task: generate + create anchor in one call (no hidden contracts)
  generateAndAnchor?(req: GenerateRequest): Promise<{
    result: GenerateResult;
    anchor: ChainAnchor;
  }>;
  // Subsequent tasks: generate using anchor
  generateChained?(req: GenerateRequest, anchor: ChainAnchor): Promise<GenerateResult>;

  // Batch (optional)
  batchCreate?(req: BatchCreateRequest): Promise<BatchJob>;
  batchGet?(jobId: string): Promise<BatchJob>;
  batchFetch?(jobId: string): Promise<BatchResult[]>;
  batchList?(): Promise<BatchJob[]>;
  batchCancel?(jobId: string): Promise<void>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/providers/types.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/types.ts scripts/providers/types.test.ts
git commit -m "feat(types): add ChainAnchor opaque type and optional chain methods to Provider"
```

---

### Task 4: Google Provider — Raw Response Preservation + Chain Implementation

**Files:**
- Modify: `scripts/providers/google.ts`
- Modify: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write failing tests for generateWithRaw**

Append to `scripts/providers/google.test.ts`:

```typescript
import { buildChainedRequestBody } from "./google";

describe("buildChainedRequestBody", () => {
  test("constructs multi-turn contents with anchor", () => {
    const anchor = {
      firstUserParts: [
        { text: "character desc + first prompt. Aspect ratio: 1:1." },
      ],
      modelContent: {
        role: "model",
        parts: [
          { thoughtSignature: "abc123" },
          {
            inlineData: {
              data: Buffer.from("anchor-img").toString("base64"),
              mimeType: "image/png",
            },
          },
        ],
      },
    };

    const body = buildChainedRequestBody(
      {
        prompt: "second prompt",
        model: "test",
        ar: null,
        quality: "2k",
        refs: [],
        imageSize: "2K",
      },
      anchor,
    );

    // Should have 3 content entries: first user, model, current user
    expect(body.contents).toHaveLength(3);
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts).toEqual(anchor.firstUserParts);
    expect(body.contents[1].role).toBe("model");
    expect(body.contents[1].parts).toEqual(anchor.modelContent.parts);
    expect(body.contents[2].role).toBe("user");
    expect(body.contents[2].parts).toHaveLength(1);
    expect((body.contents[2].parts[0] as any).text).toBe("second prompt");
  });

  test("includes current task refs in last user turn", () => {
    const { mkdtempSync, writeFileSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");
    const dir = mkdtempSync(join(tmpdir(), "chain-ref-"));
    const refPath = join(dir, "garment.png");
    writeFileSync(refPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const anchor = {
      firstUserParts: [{ text: "first prompt" }],
      modelContent: {
        role: "model",
        parts: [
          {
            inlineData: {
              data: Buffer.from("img").toString("base64"),
              mimeType: "image/png",
            },
          },
        ],
      },
    };

    const body = buildChainedRequestBody(
      {
        prompt: "wear this garment",
        model: "test",
        ar: null,
        quality: "2k",
        refs: [refPath],
        imageSize: "2K",
      },
      anchor,
    );

    const lastUserParts = body.contents[2].parts;
    // First part: inlineData (ref), second part: text
    expect(lastUserParts).toHaveLength(2);
    expect(lastUserParts[0]).toHaveProperty("inlineData");
    expect((lastUserParts[1] as any).text).toBe("wear this garment");
  });

  test("appends aspect ratio to current prompt", () => {
    const anchor = {
      firstUserParts: [{ text: "first" }],
      modelContent: { role: "model", parts: [] },
    };

    const body = buildChainedRequestBody(
      {
        prompt: "second",
        model: "test",
        ar: "16:9",
        quality: "2k",
        refs: [],
        imageSize: "2K",
      },
      anchor,
    );

    const textPart = body.contents[2].parts[0] as { text: string };
    expect(textPart.text).toContain("Aspect ratio: 16:9");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/providers/google.test.ts`
Expected: FAIL — `buildChainedRequestBody` not exported

- [ ] **Step 3: Write failing test for createGoogleAnchor**

Add `createGoogleAnchor` to the existing import from `"./google"` in `scripts/providers/google.test.ts`:

```typescript
import { createGoogleAnchor } from "./google";
```

Then append:

```typescript
describe("createGoogleAnchor", () => {
  test("captures firstUserParts and raw modelContent", () => {
    const firstReq = {
      prompt: "first prompt",
      model: "test",
      ar: "1:1" as string | null,
      quality: "2k" as const,
      refs: [],
      imageSize: "2K" as const,
    };

    const rawResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { thoughtSignature: "sig1" },
              {
                inlineData: {
                  data: Buffer.from("img").toString("base64"),
                  mimeType: "image/png",
                },
              },
              { thoughtSignature: "sig2" },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const anchor = createGoogleAnchor(firstReq, rawResponse);
    expect(anchor.firstUserParts).toHaveLength(1);
    expect((anchor.firstUserParts[0] as any).text).toContain("first prompt");
    expect(anchor.modelContent.role).toBe("model");
    expect(anchor.modelContent.parts).toHaveLength(3);
    expect((anchor.modelContent.parts[0] as any).thoughtSignature).toBe("sig1");
  });
});
```

- [ ] **Step 4: Implement buildChainedRequestBody, createGoogleAnchor, and wire into provider**

Add to `scripts/providers/google.ts`:

```typescript
// Google-internal chain anchor type
interface GoogleChainAnchor {
  firstUserParts: Array<Record<string, unknown>>;
  modelContent: { role: string; parts: Array<Record<string, unknown>> };
}

export function createGoogleAnchor(
  firstReq: GenerateRequest,
  rawResponse: unknown,
): GoogleChainAnchor {
  const body = buildRealtimeRequestBody(firstReq);
  const firstUserParts = body.contents[0].parts;

  const resp = rawResponse as {
    candidates?: Array<{
      content?: { role: string; parts: Array<Record<string, unknown>> };
    }>;
  };
  const modelContent = resp.candidates?.[0]?.content;
  if (!modelContent) {
    throw new Error("Cannot create chain anchor: no model content in response");
  }

  return { firstUserParts, modelContent };
}

export function buildChainedRequestBody(
  req: GenerateRequest,
  anchor: GoogleChainAnchor,
): {
  contents: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  generationConfig: {
    responseModalities: string[];
    imageConfig: { imageSize: string };
  };
} {
  // Current user turn: task-specific refs (NOT character refs) + prompt
  const currentParts: Array<Record<string, unknown>> = [];
  for (const refPath of req.refs) {
    const data = readFileSync(refPath);
    const ext = refPath.split(".").pop()?.toLowerCase();
    const mimeType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    currentParts.push({
      inlineData: {
        data: Buffer.from(data).toString("base64"),
        mimeType,
      },
    });
  }
  let promptText = req.prompt;
  if (req.ar) {
    promptText += `. Aspect ratio: ${req.ar}.`;
  }
  currentParts.push({ text: promptText });

  return {
    contents: [
      { role: "user", parts: anchor.firstUserParts },
      { role: anchor.modelContent.role, parts: anchor.modelContent.parts },
      { role: "user", parts: currentParts },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { imageSize: req.imageSize },
    },
  };
}
```

Refactor `generateWithRetry` into `generateCore` (internal) for reuse:

```typescript
async function generateCore(
  req: GenerateRequest,
): Promise<{ result: GenerateResult; rawResponse: unknown }> {
  const url = `${baseUrl}/v1beta/models/${req.model}:generateContent`;
  const body = buildRealtimeRequestBody(req);

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const res = await httpPost(url, body, apiKey);

    if (res.status === 200) {
      return {
        result: parseGenerateResponse(res.data as Parameters<typeof parseGenerateResponse>[0]),
        rawResponse: res.data,
      };
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
```

Update `generateWithRetry` and add `generateAndAnchor` + `generateChained` to the returned Provider:

```typescript
async function generateWithRetry(req: GenerateRequest): Promise<GenerateResult> {
  const { result } = await generateCore(req);
  return result;
}

// In createGoogleProvider return object:
return {
  name: "google",
  defaultModel: "gemini-3.1-flash-image-preview",
  generate: generateWithRetry,

  // Chain: first task — generate + create anchor in one call
  async generateAndAnchor(req: GenerateRequest) {
    const { result, rawResponse } = await generateCore(req);
    const anchor = createGoogleAnchor(req, rawResponse);
    return { result, anchor };
  },

  // Chain: subsequent tasks — generate using anchor
  async generateChained(req: GenerateRequest, anchor: ChainAnchor) {
    const googleAnchor = anchor as GoogleChainAnchor;
    const url = `${baseUrl}/v1beta/models/${req.model}:generateContent`;
    const body = buildChainedRequestBody(req, googleAnchor);

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await httpPost(url, body, apiKey);
      if (res.status === 200) {
        return parseGenerateResponse(res.data as Parameters<typeof parseGenerateResponse>[0]);
      }
      if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }
      await Bun.sleep(RETRY_DELAYS[attempt]);
    }
    throw new Error("Unreachable");
  },

  // ... existing batch methods unchanged
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test scripts/providers/google.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "feat(google): implement chain anchor creation, chained request building, and raw response preservation"
```

---

### Task 5: Generate Command — Character Injection + Chain Orchestration

**Files:**
- Modify: `scripts/commands/generate.ts`
- Modify: `scripts/commands/generate.test.ts`

- [ ] **Step 1: Write failing tests for chain orchestration logic**

Add imports to existing import line in `scripts/commands/generate.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
```

Then append test cases:

```typescript
describe("chain mode edge cases", () => {
  test("validateGenerateArgs allows --chain without --prompts for single prompt", () => {
    expect(() => validateGenerateArgs({ prompt: "A cat" })).not.toThrow();
  });

  test("validateGenerateArgs still requires prompt or prompts", () => {
    expect(() => validateGenerateArgs({})).toThrow("--prompt or --prompts is required");
  });
});
```

Note: Full chain orchestration tests require mocking the Provider, which is best done in the integration test (Task 8). The unit tests here verify input validation only.

- [ ] **Step 2: Implement character injection and chain orchestration in generate.ts**

Update `scripts/commands/generate.ts`:

```typescript
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { GenerateRequest, GenerateResult, Provider, ChainAnchor } from "../providers/types";
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
import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs, type CharacterProfile } from "../lib/character";

export interface GenerateFlags {
  prompt?: string;
  prompts?: string;
  ref?: string[];
  character?: string;   // NEW
  chain?: boolean;       // NEW
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

// No hidden contracts — generateAndAnchor is in the public Provider interface

export async function runGenerate(
  provider: Provider,
  config: Config,
  flags: {
    prompt?: string;
    prompts?: string;
    ref?: string[];
    outdir: string;
    json: boolean;
    character?: string;
    chain?: boolean;
  },
): Promise<void> {
  validateGenerateArgs(flags);
  ensureOutdir(flags.outdir);

  // Load character profile if specified
  const character = flags.character
    ? loadCharacter(resolve(flags.character))
    : null;

  const tasks = loadPrompts(flags, {
    model: config.model,
    ar: config.ar,
    quality: config.quality,
    refs: flags.ref?.map((r) => resolve(r)) ?? [],
  });

  // Resolve all refs to absolute paths FIRST (before dedup in mergeCharacterRefs)
  for (const task of tasks) {
    task.refs = task.refs.map((r) => resolve(r));
  }

  // Apply character: prompt injection for ALL tasks, ref injection depends on chain mode
  const useChain = flags.chain === true && tasks.length > 1;
  if (character) {
    for (let i = 0; i < tasks.length; i++) {
      // Always inject description + negative into prompt
      tasks[i].prompt = applyCharacterPrompt(tasks[i].prompt, character);
      // Merge character refs: always for non-chain, only first task for chain
      if (!useChain || i === 0) {
        tasks[i].refs = mergeCharacterRefs(tasks[i].refs, character);
      }
      // Chain tasks 2..N: character refs are already in anchor's firstUserParts
      // Only task-specific refs (from prompts.json "ref" field) are sent
    }
  }

  let anchor: ChainAnchor | undefined;

  let seq = nextSeqNumber(flags.outdir);

  for (let taskIdx = 0; taskIdx < tasks.length; taskIdx++) {
    const task = tasks[taskIdx];
    const isFirstTask = taskIdx === 0;

    const req: GenerateRequest = {
      prompt: task.prompt,
      model: config.model,
      ar: task.ar ?? null,
      quality: task.quality ?? config.quality,
      refs: task.refs,
      imageSize: mapQualityToImageSize(task.quality ?? config.quality),
    };

    let result: GenerateResult;

    if (useChain && !isFirstTask && anchor) {
      // Chained generation: use anchor
      if (!provider.generateChained) {
        throw new Error(`Provider ${provider.name} does not support chain mode`);
      }
      try {
        result = await provider.generateChained(req, anchor);
      } catch (err) {
        // Subsequent task failure: skip and continue
        const msg = err instanceof Error ? err.message : String(err);
        if (flags.json) {
          console.log(JSON.stringify({ error: msg, prompt: task.prompt, skipped: true }));
        } else {
          console.error(`[skip] ${task.prompt.slice(0, 60)}... — ${msg}`);
        }
        continue;
      }
    } else if (useChain && isFirstTask) {
      // First task in chain: generate + create anchor in one call
      if (!provider.generateAndAnchor) {
        throw new Error(`Provider ${provider.name} does not support chain mode`);
      }
      const { result: firstResult, anchor: newAnchor } =
        await provider.generateAndAnchor(req);
      result = firstResult;

      // First image guard
      if (result.finishReason === "SAFETY" || result.images.length === 0) {
        const msg = result.safetyInfo
          ? `Chain aborted: first image generation failed — ${result.safetyInfo.reason}`
          : "Chain aborted: first image generation failed (no image returned)";
        if (flags.json) {
          console.log(JSON.stringify({ error: msg, finishReason: result.finishReason }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }
      if (result.images.length > 1) {
        const msg =
          "Chain aborted: first task returned multiple images, cannot determine anchor. Use a more specific prompt for the first task.";
        if (flags.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      anchor = newAnchor;
    } else {
      // Normal (non-chain) generation
      result = await provider.generate(req);
    }

    // Handle safety block (non-chain or first-task already handled above)
    if (result.finishReason === "SAFETY") {
      const msg = result.safetyInfo
        ? `Safety block: ${result.safetyInfo.category} — ${result.safetyInfo.reason}`
        : "Content blocked by safety filter";
      if (flags.json) {
        console.log(
          JSON.stringify({
            error: msg,
            finishReason: "SAFETY",
            safetyInfo: result.safetyInfo,
          }),
        );
      } else {
        console.error(msg);
      }
      if (!useChain) process.exit(1);
      continue; // In chain mode for non-first tasks, skip
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
      if (!useChain) process.exit(1);
      continue; // In chain mode for non-first tasks, skip
    }

    // Write images
    const slug = generateSlug(task.prompt);
    for (let imgIdx = 0; imgIdx < result.images.length; imgIdx++) {
      const img = result.images[imgIdx];
      const ext = mimeToExt(img.mimeType);
      const imgSlug =
        result.images.length > 1
          ? `${slug}-${String.fromCharCode(97 + imgIdx)}`
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

- [ ] **Step 3: Run all existing tests to verify no regressions**

Run: `bun test scripts/commands/generate.test.ts`
Expected: All tests PASS (existing tests use `validateGenerateArgs` and `loadPrompts` which are unchanged in behavior)

- [ ] **Step 4: Commit**

```bash
git add scripts/commands/generate.ts scripts/commands/generate.test.ts
git commit -m "feat(generate): add character injection and chain mode orchestration"
```

---

### Task 6: Batch Command — Character Injection + Chain Warning + Payload Guard

**Files:**
- Modify: `scripts/commands/batch.ts:76-115` (batchSubmit function)

- [ ] **Step 1: Modify batchSubmit to support --character, warn on --chain, and add payload guardrail**

In `scripts/commands/batch.ts`:
- Add to the existing imports (merge, do NOT create duplicate import lines):
  ```typescript
  import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs } from "../lib/character";
  ```
  Note: `resolve` is already imported from `"path"` on line 2.

Update `batchSubmit`:

```typescript
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

  // Warn if --chain used with batch
  if (args.flags.chain) {
    console.error(
      "Warning: --chain is not supported in batch mode (each request is independent). Ignored.",
    );
  }

  // Load character profile if specified
  const character = args.flags.character
    ? loadCharacter(resolve(args.flags.character))
    : null;

  const filePath = resolve(args.positional);
  const content = readFileSync(filePath, "utf-8");
  const rawTasks = JSON.parse(content) as Array<{
    prompt: string;
    ar?: string;
    quality?: "normal" | "2k";
    ref?: string[];
  }>;

  const dir = dirname(filePath);
  const tasks: GenerateRequest[] = rawTasks.map((t) => {
    let prompt = t.prompt;
    let refs = t.ref?.map((r) => resolve(dir, r)) ?? [];

    // Apply character profile
    if (character) {
      prompt = applyCharacterPrompt(prompt, character);
      refs = mergeCharacterRefs(refs, character);
    }

    return {
      prompt,
      model: config.model,
      ar: t.ar ?? config.ar,
      quality: t.quality ?? config.quality,
      refs,
      imageSize: mapQualityToImageSize(t.quality ?? config.quality),
    };
  });

  // Payload estimation guardrail (total: character refs + task refs + prompts per task)
  {
    const BASE64_OVERHEAD = 1.37;
    const JSON_OVERHEAD_PER_TASK = 512; // JSON structure, metadata keys, etc.
    let totalEstimate = 0;
    for (const task of tasks) {
      // Refs for this task (includes character refs if merged)
      let taskRefBytes = 0;
      for (const refPath of task.refs) {
        taskRefBytes += readFileSync(refPath).length;
      }
      totalEstimate += taskRefBytes * BASE64_OVERHEAD;
      totalEstimate += Buffer.byteLength(task.prompt, "utf-8");
      totalEstimate += JSON_OVERHEAD_PER_TASK;
    }
    const LIMIT = 20 * 1024 * 1024;
    if (totalEstimate > LIMIT) {
      const charRefNote = character
        ? ` Character references are duplicated across all ${tasks.length} tasks — consider removing them or reducing tasks per batch.`
        : "";
      throw new Error(
        `Estimated batch payload (~${Math.round(totalEstimate / 1024 / 1024)}MB) exceeds 20MB limit.${charRefNote}`,
      );
    }
  }

  // ... rest of batchSubmit unchanged (outdir, provider.batchCreate, manifest, etc.)
}
```

- [ ] **Step 2: Run all tests to verify no regressions**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add scripts/commands/batch.ts
git commit -m "feat(batch): add character injection, chain warning, and payload guardrail"
```

---

### Task 7: Main Entry Point — Pass New Flags

**Files:**
- Modify: `scripts/main.ts:37-46` (generate case)

- [ ] **Step 1: Update main.ts to pass character and chain flags**

In `scripts/main.ts`, update the generate case:

```typescript
case "generate":
  await runGenerate(provider, config, {
    prompt: args.flags.prompt,
    prompts: args.flags.prompts,
    ref: args.flags.ref,
    outdir: args.flags.outdir,
    json: args.flags.json,
    character: args.flags.character,  // NEW
    chain: args.flags.chain,          // NEW
  });
  break;
```

Also update the batch case to pass character and chain through args (already in args.flags, batch.ts reads from args directly — no change needed).

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add scripts/main.ts
git commit -m "feat(main): wire --character and --chain flags to generate command"
```

---

### Task 8: Integration Smoke Test

**Files:**
- Modify: `scripts/integration.test.ts`

- [ ] **Step 1: Write integration test for character + chain CLI parsing end-to-end**

Add new imports to `scripts/integration.test.ts` (merge into existing imports — `describe`, `test`, `expect` are already imported):

```typescript
// Add these imports (do NOT duplicate existing ones)
import { parseArgs } from "./lib/args";
import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs } from "./lib/character";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("character + chain integration", () => {
  test("full CLI arg parsing with character and chain", () => {
    const args = parseArgs([
      "generate",
      "--prompts",
      "prompts.json",
      "--character",
      "model-a.json",
      "--chain",
      "--outdir",
      "./out",
    ]);
    expect(args.command).toBe("generate");
    expect(args.flags.prompts).toBe("prompts.json");
    expect(args.flags.character).toBe("model-a.json");
    expect(args.flags.chain).toBe(true);
    expect(args.flags.outdir).toBe("./out");
  });

  test("character profile loads and applies to prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "integ-"));
    const refPath = join(dir, "ref.png");
    writeFileSync(refPath, Buffer.from([0x89, 0x50]));
    const charPath = join(dir, "char.json");
    writeFileSync(
      charPath,
      JSON.stringify({
        description: "A tall woman",
        negative: "No glasses",
        references: ["./ref.png"],
      }),
    );

    const profile = loadCharacter(charPath);
    const prompt = applyCharacterPrompt("in a garden", profile);
    const refs = mergeCharacterRefs(["/task/other.png"], profile);

    expect(prompt).toBe("A tall woman No glasses in a garden");
    expect(refs).toEqual([refPath, "/task/other.png"]);
  });

  test("batch args parse --character without --chain", () => {
    const args = parseArgs([
      "batch",
      "submit",
      "prompts.json",
      "--character",
      "char.json",
    ]);
    expect(args.flags.character).toBe("char.json");
    expect(args.flags.chain).toBe(false);
  });
});

describe("chain orchestration with fake provider", () => {
  test("first task calls generateAndAnchor, subsequent call generateChained", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chain-orch-"));
    const promptsPath = join(dir, "prompts.json");
    writeFileSync(
      promptsPath,
      JSON.stringify([
        { prompt: "standing portrait" },
        { prompt: "outdoor scene" },
      ]),
    );

    const calls: string[] = [];
    const fakeImage = {
      data: new Uint8Array([0x89, 0x50]),
      mimeType: "image/png",
    };
    const fakeResult = { images: [fakeImage], finishReason: "STOP" as const };
    const fakeAnchor = { fake: true };

    const fakeProvider = {
      name: "fake",
      defaultModel: "fake-model",
      generate: async () => {
        calls.push("generate");
        return fakeResult;
      },
      generateAndAnchor: async () => {
        calls.push("generateAndAnchor");
        return { result: fakeResult, anchor: fakeAnchor };
      },
      generateChained: async () => {
        calls.push("generateChained");
        return fakeResult;
      },
    };

    const { runGenerate } = await import("./commands/generate");
    await runGenerate(fakeProvider as any, {
      provider: "fake",
      model: "fake-model",
      quality: "normal" as const,
      ar: "1:1",
      apiKey: "fake",
      baseUrl: "http://fake",
    }, {
      prompts: promptsPath,
      outdir: dir,
      json: true,
      chain: true,
    });

    expect(calls).toEqual(["generateAndAnchor", "generateChained"]);
  });

  test("chain aborts if first image returns zero images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chain-fail-"));
    const promptsPath = join(dir, "prompts.json");
    writeFileSync(
      promptsPath,
      JSON.stringify([
        { prompt: "first" },
        { prompt: "second" },
      ]),
    );

    const fakeProvider = {
      name: "fake",
      defaultModel: "fake-model",
      generate: async () => ({ images: [], finishReason: "SAFETY" as const }),
      generateAndAnchor: async () => ({
        result: { images: [], finishReason: "SAFETY" as const },
        anchor: {},
      }),
      generateChained: async () => ({ images: [], finishReason: "STOP" as const }),
    };

    const { runGenerate } = await import("./commands/generate");
    // Should call process.exit(1) — we test by catching
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => { exitCode = code; }) as any;
    try {
      await runGenerate(fakeProvider as any, {
        provider: "fake", model: "fake", quality: "normal" as const,
        ar: "1:1", apiKey: "fake", baseUrl: "http://fake",
      }, {
        prompts: promptsPath, outdir: dir, json: true, chain: true,
      });
    } catch { /* ignore */ }
    process.exit = originalExit;
    expect(exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `bun test scripts/integration.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run full test suite one final time**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/integration.test.ts
git commit -m "test: add integration tests for character + chain feature"
```
