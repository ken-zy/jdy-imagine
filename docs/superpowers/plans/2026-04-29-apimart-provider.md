# apimart Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third image-generation provider `apimart` (China gateway for OpenAI gpt-image-2) supporting async task model, automatic image upload via apimart's own `/v1/uploads/images` endpoint, 4K output, and 13-value aspect ratio set. Concurrently repay the `quality` field abstraction debt by splitting it into `--resolution` and `--detail`.

> **Corrigendum (post-PR #5):** The shipped implementation defines `RETRYABLE_STATUS` as `{0, 429, 500, 502, 503}`, not the `{429, 500, 502, 503}` written throughout this plan. The extra `0` covers `httpGetBytes`'s network-failure mode — unlike `httpPost` / `httpGet` (which surface fetch errors as the `503` sentinel), `httpGetBytes` returns `status=0` so the download path needs `0` in the retry set to reuse the same `callWithApimartRetry`. Read every `{429,500,502,503}` reference below as `{0,429,500,502,503}`.

**Architecture:**

- Two PRs landed sequentially. **PR 1** (`refactor/quality-to-resolution-detail`) is a pure refactor: rename `--quality` → `--resolution` + `--detail`, no new functionality. **PR 2** (`feat/apimart-provider`) is the new provider, based on PR 1's main.
- apimart provider is fully async: spawn upload → submit → poll task → download URL bytes. All four endpoints share an apimart-local retry helper (`callWithApimartRetry`) with `RETRYABLE_STATUS={429,500,502,503}` (not the shared `lib/http` retry set, which only has `{429,500,503}`).
- Image inputs (refs/edit/mask) auto-upload via apimart's own multipart endpoint, returning 72h-valid public URLs — no Cloudflare R2, no wrangler dependency. Run-scoped sha256 cache (Map<hash, Promise<url>>) deduplicates concurrent same-hash uploads.

**Tech Stack:** Bun runtime, TypeScript, custom HTTP layer (`scripts/lib/http.ts`), Bun built-in `CryptoHasher` for sha256, no new npm dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-28-apimart-provider-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/providers/types.ts` | Modify | Drop `quality`/`imageSize`/`mapQualityToImageSize`; add `resolution`/`detail` to GenerateRequest; add optional `validateRequest?` to Provider |
| `scripts/lib/http.ts` | Modify | Add raw `httpGetBytes(url, headers?)` helper (no retry; retry handled by callers) |
| `scripts/lib/args.ts` | Modify | Drop `--quality`; add `--resolution`/`--detail`; expand `--ar` enum to 13 values |
| `scripts/lib/config.ts` | Modify | Drop `quality`; add `resolution` (default `"2k"`) + `detail` (default `"high"`); add APIMART_* env group; export `QUALITY_REMOVED_MSG` |
| `scripts/providers/google.ts` | Modify | Adapt to `resolution`/`detail`; derive uppercase `imageSize` internally; new ar throw; remove `mapQualityToImageSize` re-export; implement `validateRequest` |
| `scripts/providers/openai.ts` | Modify | `detail` → OpenAI quality field passthrough; SIZE_TABLE indexed by `resolution`; `resolution=4k` throw; new ar throw; implement `validateRequest`; remove `mapToOpenAIQuality` |
| `scripts/providers/apimart.ts` | Create | apimart factory + async generate (upload/submit/poll/download); sha256-keyed Promise cache; `callWithApimartRetry` helper; `validateRequest` (13-ar set + 4k-6-ar subset) |
| `scripts/main.ts` | Modify | Register `apimart` in PROVIDERS map; missing-API-key error message includes APIMART_API_KEY |
| `scripts/commands/generate.ts` | Modify | Field rename quality→resolution/detail; remove old `mask && provider.name !== "openai"` guard; move 16-image check to post-merge preflight; call `provider.validateRequest` for all final reqs before main loop |
| `scripts/commands/batch.ts` | Modify | Field rename; apimart provider check (no batchCreate → throw friendly message); prompts.json `quality` → throw migration |
| `scripts/lib/http.test.ts` | Modify | Add `httpGetBytes` raw test (no JSON.parse, ArrayBuffer/Uint8Array round-trip) |
| `scripts/lib/args.test.ts` | Modify | New `--resolution`/`--detail` parsing; `--quality` throw migration; 13-value ar parsing |
| `scripts/lib/config.test.ts` | Modify | apimart env group; default_quality throw; default_resolution=2k + default_detail=high |
| `scripts/providers/types.test.ts` | Modify | Drop `mapQualityToImageSize` test; new GenerateRequest field shape; Provider has optional `validateRequest` |
| `scripts/providers/google.test.ts` | Modify | resolution/detail adaptation; new-ar throw; resolution=4k throw; validateRequest impl |
| `scripts/providers/openai.test.ts` | Modify | detail passthrough (no medium/high hardcoding); new-ar throw; resolution=4k throw; validateRequest impl |
| `scripts/providers/apimart.test.ts` | Create | Upload payload; sha256 cache (sequential + concurrent + reject-cleanup); pollTask state machine (status union, fail_reason vs error.{code,message,type}); ar/4k validation; mask routing; HTTPS_PROXY rejection; download bytes |
| `scripts/commands/generate.test.ts` | Modify | resolution/detail passthrough; mask + apimart not blocked; 16-image post-merge check |
| `scripts/commands/batch.test.ts` | Modify | apimart subcommands → friendly throw; prompts.json `quality` → throw |
| `scripts/integration.test.ts` | Modify | Add apimart e2e: text-to-image / image-to-image (with cache assertion: character profile + 10 prompts uploads each unique image once) / failed-safety / timeout / cancelled |
| `EXTEND.md.example` | Modify | Replace `default_quality: 2k` with `default_resolution: 2k` + `default_detail: high` |
| `README.md` | Modify | Three-provider matrix; `--resolution`/`--detail` usage; apimart section (env, 72h-URL note, HTTPS_PROXY constraint, timeout/task_id hint); migration chapter |
| `SKILL.md` | Modify | Same usage examples as README; description mentions three providers |

---

## PR 1 — `--quality` Abstraction Debt Refactor

**Branch:** Create `refactor/quality-to-resolution-detail` from latest `origin/main`.

```bash
git fetch origin && git checkout -b refactor/quality-to-resolution-detail origin/main
```

### Migration strategy: additive-then-cleanup (revised — every commit green)

This PR has 7 commits. Each commit produces a **green build** (`bun test` passes) by following these rules:

- **Tasks 1.1–1.5**: Add new fields/flags additively. **All legacy is preserved** — `--quality` flag still works, `default_quality` accepted (no throw), prompts.json `quality` field still tolerated, `mapQualityToImageSize` still exported, `google.ts:19` re-export still present, `imageSize` still on GenerateRequest.
- **Task 1.6 (single migration commit)**: All breaking flips happen here in one atomic commit:
  - Drop `--quality` flag + add migration throw
  - Reject EXTEND.md `default_quality`
  - Reject prompts.json `quality` field
  - Migrate ALL test fixtures (integration.test.ts / generate.test.ts / batch.test.ts)
  - Migrate EXTEND.md.example (also drop `default_model:` per P1-1)
  - Update README + SKILL.md (migration chapter includes `default_model` advisory)
  - Move 16-image check to post-merge preflight
  - Remove `provider.name === "openai"` mask guard
- **Task 1.7 (final cleanup)**: Remove all legacy field/function definitions:
  - Drop `quality` / `imageSize` from GenerateRequest
  - Drop `mapQualityToImageSize` function entirely + `google.ts:19` re-export
  - Drop `Config.quality` derived field + `ParsedArgs.flags.quality` field
  - Drop dual-fill code in commands

By 1.7 no consumer reads legacy, so deletion is safe; tests stay green.

**Build invariant**: After every numbered task commit, `bun test` passes. The fixture-migration step in Task 1.6 is bundled with the flag/key flips so the commit is atomic; Tasks 1.2-1.5 do not break any existing test because they only add. Task 1.7 only removes definitions whose readers were eliminated in 1.4-1.6.

### Task 1.1: types.ts — ADDITIVE: Add resolution/detail/validateRequest (Keep Old Fields)

**Files:**
- Modify: `scripts/providers/types.ts`
- Test: `scripts/providers/types.test.ts`

**Why additive**: Removing `quality`/`imageSize` from `GenerateRequest` immediately would break `google.ts` (uses `req.imageSize`), `openai.ts` (uses `req.quality`), `commands/generate.ts` (line 161 uses `mapQualityToImageSize`), and many other call sites — leaving a broken commit on the branch. Instead this task only **adds** new fields/methods; old fields stay until Task 1.7 (final cleanup) when no consumer reads them anymore. Every commit between 1.1 and 1.7 produces a green build.

- [ ] **Step 1: Write tests for additive shape**

Append to `scripts/providers/types.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { GenerateRequest, Provider } from "./types";

describe("GenerateRequest additive — resolution/detail coexist with quality/imageSize", () => {
  it("accepts resolution + detail alongside quality + imageSize", () => {
    const req: GenerateRequest = {
      prompt: "a cat",
      model: "gpt-image-2",
      ar: "16:9",
      // both old and new fields valid during transition:
      quality: "2k",
      imageSize: "2K",
      resolution: "2k",
      detail: "high",
      refs: [],
    };
    expect(req.resolution).toBe("2k");
    expect(req.detail).toBe("high");
    expect(req.quality).toBe("2k");
  });
});

describe("Provider interface — validateRequest hook", () => {
  it("optional validateRequest is acceptable on Provider", () => {
    const p: Provider = {
      name: "test",
      defaultModel: "x",
      generate: async () => ({ images: [], finishReason: "STOP" }),
      validateRequest: (req) => { void req; },
    };
    expect(p.validateRequest).toBeDefined();
  });

  it("provider without validateRequest still satisfies Provider type", () => {
    const p: Provider = {
      name: "test",
      defaultModel: "x",
      generate: async () => ({ images: [], finishReason: "STOP" }),
    };
    expect(p.validateRequest).toBeUndefined();
  });
});
```

Existing tests that reference `mapQualityToImageSize` stay as-is for now (function still exists).

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test scripts/providers/types.test.ts`
Expected: FAIL — `resolution` / `detail` not on `GenerateRequest` type; `validateRequest?` not on `Provider`.

- [ ] **Step 3: Update `scripts/providers/types.ts` (additive)**

```ts
// scripts/providers/types.ts (excerpt — keep ALL existing fields/functions including quality, imageSize, mapQualityToImageSize)
export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;
  // legacy (kept until Task 1.7):
  quality: "normal" | "2k";
  imageSize: "1K" | "2K" | "4K";
  // new (additive):
  resolution: "1k" | "2k" | "4k";
  detail: "auto" | "low" | "medium" | "high";
  refs: string[];
  editTarget?: string;
  mask?: string;
}

export interface Provider {
  name: string;
  defaultModel: string;
  validateRequest?(req: GenerateRequest): void;  // NEW (optional)
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateAndAnchor?(req: GenerateRequest): Promise<{ result: GenerateResult; anchor: ChainAnchor }>;
  generateChained?(req: GenerateRequest, anchor: ChainAnchor): Promise<GenerateResult>;
  batchCreate?(req: BatchCreateRequest): Promise<BatchJob>;
  batchGet?(jobId: string): Promise<BatchJob>;
  batchFetch?(jobId: string): Promise<BatchResult[]>;
  batchList?(): Promise<BatchJob[]>;
  batchCancel?(jobId: string): Promise<void>;
}

// mapQualityToImageSize still exported (deleted in Task 1.7)
```

- [ ] **Step 4: Run all tests to verify suite is still green**

Run: `bun test`
Expected: ALL PASS — no consumers were modified, all old fields still present, only additions.

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/types.ts scripts/providers/types.test.ts
git commit -m "refactor(types): add resolution/detail/validateRequest (additive; old fields kept)"
```

---

### Task 1.2: args.ts — ADD `--resolution`/`--detail` and 13-value `--ar` (legacy `--quality` retained until 1.6)

**Files:**
- Modify: `scripts/lib/args.ts`
- Test: `scripts/lib/args.test.ts`

- [ ] **Step 1: Write failing tests**

Add these cases to `scripts/lib/args.test.ts` (append; do NOT modify existing `--quality` cases — they must keep passing in this task):

```ts
describe("args resolution/detail/ar", () => {
  it("parses --resolution 4k --detail high", () => {
    const a = parseArgs(["generate", "--prompt", "x", "--resolution", "4k", "--detail", "high"]);
    expect(a.flags.resolution).toBe("4k");
    expect(a.flags.detail).toBe("high");
  });

  it("rejects invalid --resolution", () => {
    expect(() => parseArgs(["generate", "--prompt", "x", "--resolution", "8k"])).toThrow();
  });

  it("rejects invalid --detail", () => {
    expect(() => parseArgs(["generate", "--prompt", "x", "--detail", "ultra"])).toThrow();
  });

  it("accepts all 13 ar values", () => {
    const ars = ["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","2:1","1:2","21:9","9:21"];
    for (const ar of ars) {
      const a = parseArgs(["generate", "--prompt", "x", "--ar", ar]);
      expect(a.flags.ar).toBe(ar);
    }
  });

  it("rejects invalid --ar", () => {
    expect(() => parseArgs(["generate", "--prompt", "x", "--ar", "7:13"])).toThrow();
  });
});
```

**Important: do not add `--quality` throw in this task.** The throw lands in Task 1.6 alongside fixture migration. Existing args.test.ts cases that use `--quality` must keep passing here — Task 1.2 is purely additive on the args layer.

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test scripts/lib/args.test.ts`
Expected: FAIL on new cases (parsing missing); FAIL on legacy `--quality` cases that are no longer accepted.

- [ ] **Step 3: Implement in `scripts/lib/args.ts`**

Additive only. Keep existing `--quality` parser case fully working. Add `--resolution`/`--detail` flag handlers and expand `--ar` validation set.

```ts
// scripts/lib/args.ts (excerpt — keep existing --quality case as-is; ADD new flags + validation)

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
    quality?: string;             // legacy — kept until Task 1.7 cleanup
    resolution?: string;          // NEW
    detail?: string;              // NEW
    ref?: string[];
    edit?: string;
    mask?: string;
    outdir: string;
    json: boolean;
    async: boolean;
    chain: boolean;
    character?: string;
  };
}

const ALLOWED_AR = new Set([
  "1:1","16:9","9:16","4:3","3:4","3:2","2:3",
  "5:4","4:5","2:1","1:2","21:9","9:21",
]);
const ALLOWED_RESOLUTION = new Set(["1k","2k","4k"]);
const ALLOWED_DETAIL = new Set(["auto","low","medium","high"]);

// In the parseArgs switch, ADD --resolution / --detail and tighten --ar validation.
// Existing --quality case STAYS — it'll be replaced with `throw QUALITY_REMOVED_MSG` in Task 1.6.
//
//   case "--resolution": {
//     const v = nextVal(arg);
//     if (!ALLOWED_RESOLUTION.has(v)) throw new Error(`Invalid --resolution: ${v}. Must be 1k|2k|4k.`);
//     result.flags.resolution = v;
//     break;
//   }
//   case "--detail": {
//     const v = nextVal(arg);
//     if (!ALLOWED_DETAIL.has(v)) throw new Error(`Invalid --detail: ${v}. Must be auto|low|medium|high.`);
//     result.flags.detail = v;
//     break;
//   }
//   case "--ar": {
//     const v = nextVal(arg);
//     if (!ALLOWED_AR.has(v)) throw new Error(`Invalid --ar: ${v}. Must be one of: ${[...ALLOWED_AR].join(", ")}`);
//     result.flags.ar = v;
//     break;
//   }
```

No import from `config.ts` needed in this task — `QUALITY_REMOVED_MSG` is wired up in Task 1.6 when `--quality` is finally rejected.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test scripts/lib/args.test.ts`
Expected: PASS all (including legacy tests that were updated to use new flags).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/args.ts scripts/lib/args.test.ts
git commit -m "refactor(args): drop --quality; add --resolution/--detail; expand --ar to 13 values"
```

---

### Task 1.3: config.ts — Add resolution/detail/APIMART env (legacy `quality` retained until 1.7)

**Files:**
- Modify: `scripts/lib/config.ts`
- Test: `scripts/lib/config.test.ts`

- [ ] **Step 1: Write failing tests**

Update `scripts/lib/config.test.ts`. Replace existing `quality`-based tests, add apimart env tests:

```ts
describe("config resolution/detail", () => {
  it("default_resolution=2k, default_detail=high", () => {
    const c = mergeConfig({}, {}, {});
    expect(c.resolution).toBe("2k");
    expect(c.detail).toBe("high");
  });

  it("CLI flags override defaults", () => {
    const c = mergeConfig({ resolution: "4k", detail: "low" }, {}, {});
    expect(c.resolution).toBe("4k");
    expect(c.detail).toBe("low");
  });

  it("EXTEND.md default_resolution / default_detail parse", () => {
    const c = mergeConfig({}, { default_resolution: "1k", default_detail: "medium" }, {});
    expect(c.resolution).toBe("1k");
    expect(c.detail).toBe("medium");
  });

  // NOTE: EXTEND.md default_quality throw is deferred to Task 1.6 (rejected together with
  // CLI --quality and prompts.json quality, alongside fixture migration). In Task 1.3,
  // default_quality is still tolerated (legacy fields linger).
});

describe("config apimart provider", () => {
  it("provider=apimart picks APIMART_* env", () => {
    const c = mergeConfig(
      { provider: "apimart" },
      {},
      { APIMART_API_KEY: "sk-xxx", APIMART_BASE_URL: "https://x", APIMART_IMAGE_MODEL: "gpt-image-2-official" }
    );
    expect(c.provider).toBe("apimart");
    expect(c.apiKey).toBe("sk-xxx");
    expect(c.baseUrl).toBe("https://x");
    expect(c.model).toBe("gpt-image-2-official");
  });

  it("apimart default baseUrl + defaultModel", () => {
    const c = mergeConfig({ provider: "apimart" }, {}, { APIMART_API_KEY: "k" });
    expect(c.baseUrl).toBe("https://api.apimart.ai");
    expect(c.model).toBe("gpt-image-2-official");
  });
});

describe("QUALITY_REMOVED_MSG", () => {
  it("is exported and mentions migration paths", () => {
    expect(QUALITY_REMOVED_MSG).toContain("--resolution");
    expect(QUALITY_REMOVED_MSG).toContain("--detail");
    expect(QUALITY_REMOVED_MSG).toMatch(/normal.*1k.*medium/i);
    expect(QUALITY_REMOVED_MSG).toMatch(/2k.*2k.*high/i);
  });
});
```

Also remove any existing `default_quality` test cases (legacy tests that hit `quality` field need rename to `resolution`/`detail`).

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test scripts/lib/config.test.ts`
Expected: FAIL — Config has no `resolution`/`detail`; no APIMART branch; no `QUALITY_REMOVED_MSG`.

- [ ] **Step 3: Implement in `scripts/lib/config.ts`**

**Note on legacy `quality`**: This task adds `resolution`/`detail` to the `Config` interface but **keeps `quality: "normal" | "2k"`** as a derived legacy field (filled from `resolution`: `1k → "normal"`, `2k → "2k"`, `4k → "2k"` placeholder). This lets unmigrated downstream code (google.ts via req.imageSize, commands/*.ts via config.quality) keep compiling and behaving sensibly until Task 1.7 (cleanup) removes the legacy field across the board. EXTEND.md `default_quality` still throws migration (we don't accept the deprecated input form).

**Note on `default_model` provider leakage** (fix per plan-review P1-1): Current `EXTEND.md.example` ships `default_model: gemini-3.1-flash-image-preview`. With three providers, that line silently leaks Gemini's model name into apimart and openai paths. Two cleanup steps:

1. Remove `default_model:` from `EXTEND.md.example` in Task 1.6 — provider-specific env vars (`GOOGLE_IMAGE_MODEL` / `OPENAI_IMAGE_MODEL` / `APIMART_IMAGE_MODEL`) are the recommended override.
2. Document in README migration chapter (Task 1.6) that EXTEND.md `default_model` is provider-agnostic and may not match the active `--provider`; prefer per-provider env.

The `mergeConfig` priority order stays `cliFlags.model → extendMd.default_model → envModel → providerDefault.defaultModel` (no behavior change for users who explicitly set `default_model`); we just stop shipping that line by default.

Add to `scripts/lib/config.test.ts`:

```ts
it("default_model in EXTEND.md does NOT auto-leak when --provider switches without explicit model override", () => {
  // Reproduce: user has default_model: gemini, switches --provider apimart, no APIMART_IMAGE_MODEL set.
  const c = mergeConfig(
    { provider: "apimart" },
    { default_model: "gemini-3.1-flash-image-preview" },
    { APIMART_API_KEY: "k" },
  );
  // Documented behavior: default_model still wins per priority; user must use APIMART_IMAGE_MODEL or --model
  // to override. Test asserts the documented behavior so the priority change is intentional.
  expect(c.model).toBe("gemini-3.1-flash-image-preview");
  // Counter-test: with APIMART_IMAGE_MODEL set, env wins per priority order
  // (cliFlags > extendMd > envModel > providerDefault) — wait, env is BELOW extendMd.
  // To validate the documented escape hatch, use --model:
  const c2 = mergeConfig(
    { provider: "apimart", model: "gpt-image-2-official" },
    { default_model: "gemini-3.1-flash-image-preview" },
    { APIMART_API_KEY: "k" },
  );
  expect(c2.model).toBe("gpt-image-2-official");
});
```

```ts
// scripts/lib/config.ts (excerpt — legacy quality retained as derived field)
export interface Config {
  provider: string;
  model: string;
  resolution: "1k" | "2k" | "4k";
  detail: "auto" | "low" | "medium" | "high";
  /** @deprecated derived from resolution; removed in Task 1.7 cleanup */
  quality: "normal" | "2k";
  ar: string;
  apiKey: string;
  baseUrl: string;
}

const DEFAULTS = {
  provider: "google",
  resolution: "2k" as const,
  detail: "high" as const,
  ar: "1:1",
};

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; defaultModel: string }> = {
  google: {
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-3.1-flash-image-preview",
  },
  openai: {
    baseUrl: "https://api.openai.com",
    defaultModel: "gpt-image-2",
  },
  apimart: {
    baseUrl: "https://api.apimart.ai",
    defaultModel: "gpt-image-2-official",
  },
};

export const QUALITY_REMOVED_MSG =
  "--quality / default_quality / prompts.json 'quality' field has been removed.\n" +
  "Migration:\n" +
  "  --quality normal → --resolution 1k --detail medium\n" +
  "  --quality 2k     → --resolution 2k --detail high\n" +
  "EXTEND.md default_quality:\n" +
  "  default_quality: normal → default_resolution: 1k + default_detail: medium\n" +
  "  default_quality: 2k     → default_resolution: 2k + default_detail: high";

export function mergeConfig(
  cliFlags: Record<string, string | undefined>,
  extendMd: Record<string, string>,
  env: Record<string, string | undefined>,
): Config {
  // NOTE: extendMd.default_quality is NOT rejected in this task — Task 1.6 adds the throw
  // in the same commit that migrates EXTEND.md.example to drop the field, so no test breaks.
  const provider = cliFlags.provider ?? extendMd.default_provider ?? DEFAULTS.provider;
  const providerDefault = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.google;

  let apiKey = "";
  let baseUrl = providerDefault.baseUrl;
  let envModel: string | undefined;

  if (provider === "google") {
    apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? "";
    baseUrl = env.GOOGLE_BASE_URL ?? baseUrl;
    envModel = env.GOOGLE_IMAGE_MODEL;
  } else if (provider === "openai") {
    apiKey = env.OPENAI_API_KEY ?? "";
    baseUrl = env.OPENAI_BASE_URL ?? baseUrl;
    envModel = env.OPENAI_IMAGE_MODEL;
  } else if (provider === "apimart") {
    apiKey = env.APIMART_API_KEY ?? "";
    baseUrl = env.APIMART_BASE_URL ?? baseUrl;
    envModel = env.APIMART_IMAGE_MODEL;
  }

  const resolution = (cliFlags.resolution ??
    extendMd.default_resolution ??
    DEFAULTS.resolution) as "1k" | "2k" | "4k";
  const detail = (cliFlags.detail ??
    extendMd.default_detail ??
    DEFAULTS.detail) as "auto" | "low" | "medium" | "high";
  // Derive legacy quality from resolution (preserves PR-1-internal compatibility; removed in Task 1.7).
  const quality: "normal" | "2k" = resolution === "1k" ? "normal" : "2k";

  return {
    provider,
    model:
      cliFlags.model ??
      extendMd.default_model ??
      envModel ??
      providerDefault.defaultModel,
    resolution,
    detail,
    quality,
    ar: cliFlags.ar ?? extendMd.default_ar ?? DEFAULTS.ar,
    apiKey,
    baseUrl,
  };
}
```

Also update `scripts/lib/args.ts` to import `QUALITY_REMOVED_MSG` from `./config` (replace the local placeholder constant).

- [ ] **Step 4: Wire `--resolution` / `--detail` flags into `scripts/main.ts`**

Per plan-review P3-1: without this step, the new flags are parsed but never reach `resolveConfig` (only `model/provider/ar/quality` are forwarded today). Update the `resolveConfig` call:

```ts
// scripts/main.ts (excerpt — extend the resolveConfig argument)
const config = resolveConfig({
  model: args.flags.model,
  provider: args.flags.provider,
  ar: args.flags.ar,
  quality: args.flags.quality,        // legacy, still passed; removed in Task 1.7
  resolution: args.flags.resolution,  // NEW
  detail: args.flags.detail,          // NEW
});
```

Add an integration test (or extend an existing one) asserting that `bun scripts/main.ts generate --resolution 4k --detail low ...` actually surfaces resolution=4k / detail=low to the provider.

- [ ] **Step 5: Run tests**

Run: `bun test scripts/lib/config.test.ts scripts/lib/args.test.ts scripts/integration.test.ts`
Expected: PASS — including the new integration assertion that `--resolution 4k --detail low` reaches the provider via `Config`.

If you don't already have an integration test that exercises this end-to-end path, add a focused one in `scripts/integration.test.ts` here (mock provider that records the `Config` it received; assert resolution + detail forwarded correctly).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/config.ts scripts/lib/config.test.ts scripts/lib/args.ts scripts/main.ts scripts/integration.test.ts
git commit -m "refactor(config): add resolution/detail/APIMART_*; wire main.ts forwarding; export QUALITY_REMOVED_MSG"
```

---

### Task 1.4: google.ts — Adapt to resolution/detail; Internal imageSize Derivation

**Files:**
- Modify: `scripts/providers/google.ts`
- Test: `scripts/providers/google.test.ts`

- [ ] **Step 1: Write failing tests**

Update `scripts/providers/google.test.ts`. Replace `quality`-based tests with `resolution`/`detail`. Add new throws:

```ts
describe("google validateRequest", () => {
  const provider = createGoogleProvider({
    apiKey: "k", baseUrl: "https://x", model: "gemini",
  });

  it("rejects 4k", () => {
    expect(() => provider.validateRequest!({
      prompt: "x", model: "gemini", ar: "16:9",
      resolution: "4k", detail: "high", refs: [],
    })).toThrow(/4k/i);
  });

  it("rejects unsupported ar (5:4)", () => {
    expect(() => provider.validateRequest!({
      prompt: "x", model: "gemini", ar: "5:4",
      resolution: "2k", detail: "high", refs: [],
    })).toThrow(/5:4/);
  });

  it.each(["1:1","16:9","9:16","4:3","3:4","3:2","2:3"])("accepts ar %s", (ar) => {
    expect(() => provider.validateRequest!({
      prompt: "x", model: "gemini", ar,
      resolution: "2k", detail: "high", refs: [],
    })).not.toThrow();
  });
});

describe("google buildRealtimeRequestBody imageSize", () => {
  it("derives 1K from resolution=1k", () => {
    const body = buildRealtimeRequestBody({
      prompt: "x", model: "gemini", ar: null,
      resolution: "1k", detail: "high", refs: [],
    });
    expect(body.generationConfig.imageConfig.imageSize).toBe("1K");
  });

  it("derives 2K from resolution=2k", () => {
    const body = buildRealtimeRequestBody({
      prompt: "x", model: "gemini", ar: null,
      resolution: "2k", detail: "high", refs: [],
    });
    expect(body.generationConfig.imageConfig.imageSize).toBe("2K");
  });
});
```

Also update or remove all existing tests that pass `quality: "2k"` or `imageSize: "2K"` in `GenerateRequest` literals.

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test scripts/providers/google.test.ts`
Expected: FAIL on new cases; cascading FAILs from old GenerateRequest shape.

- [ ] **Step 3: Update `scripts/providers/google.ts`**

Key changes:
- Keep `google.ts:19` `export { mapQualityToImageSize } from "./types";` (still imported by `commands/generate.ts:161`; removed in Task 1.7 cleanup once commands stops using it).
- In `buildRealtimeRequestBody` and `buildChainedRequestBody` and `buildBatchJsonl` (and any other place referencing `req.imageSize`): replace `req.imageSize` with a local derivation:

```ts
function deriveGoogleImageSize(req: GenerateRequest): "1K" | "2K" {
  if (req.resolution === "4k") {
    throw new Error("Google provider does not support resolution=4k. Use --resolution 1k or 2k.");
  }
  return req.resolution === "1k" ? "1K" : "2K";
}

// in buildRealtimeRequestBody:
//   imageConfig: { imageSize: deriveGoogleImageSize(req) }
// repeat in buildChainedRequestBody and buildBatchJsonl (each tasks.map).
```

- Add the `validateRequest` implementation in the factory return:

```ts
const GOOGLE_ALLOWED_AR = new Set(["1:1","16:9","9:16","4:3","3:4","3:2","2:3"]);

function googleValidateRequest(req: GenerateRequest): void {
  if (req.resolution === "4k") {
    throw new Error("Google provider does not support resolution=4k.");
  }
  if (req.ar && !GOOGLE_ALLOWED_AR.has(req.ar)) {
    throw new Error(`Google provider does not support --ar ${req.ar}. Allowed: ${[...GOOGLE_ALLOWED_AR].join(", ")}`);
  }
}

return {
  name: "google",
  defaultModel: "gemini-3.1-flash-image-preview",
  validateRequest: googleValidateRequest,
  generate: generateWithRetry,
  // ... rest unchanged
};
```

- [ ] **Step 4: Run tests**

Run: `bun test scripts/providers/google.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/google.ts scripts/providers/google.test.ts
git commit -m "refactor(google): adapt to resolution/detail; derive imageSize internally; add validateRequest"
```

---

### Task 1.5: openai.ts — Detail Passthrough, SIZE_TABLE Reindex, validateRequest

**Files:**
- Modify: `scripts/providers/openai.ts`
- Test: `scripts/providers/openai.test.ts`

- [ ] **Step 1: Write failing tests**

Update `scripts/providers/openai.test.ts`. Replace the `mapToOpenAIQuality` test with detail passthrough; add new throws:

```ts
describe("openai detail passthrough", () => {
  it.each([["auto","auto"],["low","low"],["medium","medium"],["high","high"]])(
    "detail=%s → quality=%s",
    (detail, expected) => {
      const payload = buildGenerationsPayload({
        prompt: "x", model: "gpt-image-2", ar: "1:1",
        resolution: "2k", detail: detail as any, refs: [],
      });
      expect(payload.quality).toBe(expected);
    }
  );
});

describe("openai SIZE_TABLE reindex", () => {
  it("resolution=1k ar=1:1 → 1024x1024", () => {
    const size = mapToOpenAISize("1k", "1:1");
    expect(size).toBe("1024x1024");
  });

  it("resolution=2k ar=16:9 → 2048x1152", () => {
    const size = mapToOpenAISize("2k", "16:9");
    expect(size).toBe("2048x1152");
  });

  it("rejects resolution=4k", () => {
    expect(() => mapToOpenAISize("4k" as any, "16:9")).toThrow(/4k/);
  });
});

describe("openai validateRequest", () => {
  const provider = createOpenAIProvider({
    apiKey: "k", baseUrl: "https://x", model: "gpt-image-2",
  });

  it("rejects 4k", () => {
    expect(() => provider.validateRequest!({
      prompt: "x", model: "gpt-image-2", ar: "16:9",
      resolution: "4k", detail: "high", refs: [],
    })).toThrow(/4k/);
  });

  it("rejects unsupported ar (5:4)", () => {
    expect(() => provider.validateRequest!({
      prompt: "x", model: "gpt-image-2", ar: "5:4",
      resolution: "2k", detail: "high", refs: [],
    })).toThrow(/5:4/);
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test scripts/providers/openai.test.ts`
Expected: FAIL — `mapToOpenAIQuality` still exists; SIZE_TABLE indexed by quality not resolution; no validateRequest.

- [ ] **Step 3: Update `scripts/providers/openai.ts`**

Key changes:
- Remove `mapToOpenAIQuality` function entirely.
- Reindex `SIZE_TABLE`: change top-level key from `"normal" | "2k"` to `"1k" | "2k"`. Replace existing key `"normal"` → `"1k"`. (Values unchanged.)
- `mapToOpenAISize` signature: change `quality: "normal" | "2k"` → `resolution: "1k" | "2k" | "4k"`; throw if `resolution === "4k"`.
- `buildGenerationsPayload` and `buildEditFormData`: use `req.resolution` for size lookup, `req.detail` directly for quality field.

```ts
const SIZE_TABLE: Record<"1k" | "2k", Record<string, string>> = {
  "1k": {
    "1:1":  "1024x1024",
    "16:9": "1536x864",
    "9:16": "864x1536",
    "3:2":  "1536x1024",
    "2:3":  "1024x1536",
    "4:3":  "1280x960",
    "3:4":  "960x1280",
  },
  "2k": {
    "1:1":  "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2":  "2304x1536",
    "2:3":  "1536x2304",
    "4:3":  "2048x1536",
    "3:4":  "1536x2048",
  },
};

export function mapToOpenAISize(resolution: "1k" | "2k" | "4k", ar: string | null): string {
  if (resolution === "4k") {
    throw new Error("OpenAI provider does not support resolution=4k.");
  }
  const effectiveAr = ar ?? "1:1";
  const size = SIZE_TABLE[resolution]?.[effectiveAr];
  if (!size) {
    const supported = Object.keys(SIZE_TABLE[resolution]).join(", ");
    throw new Error(`Unsupported ar "${effectiveAr}" for resolution "${resolution}". Supported: ${supported}`);
  }
  return size;
}

export function buildGenerationsPayload(req: GenerateRequest): Record<string, unknown> {
  return {
    model: req.model,
    prompt: req.prompt,
    n: 1,
    size: mapToOpenAISize(req.resolution, req.ar),
    quality: req.detail,
    output_format: "png",
  };
}

// buildEditFormData: same — replace mapToOpenAIQuality(req.quality) with req.detail in the FormData.append.
```

- Add `validateRequest`:

```ts
const OPENAI_ALLOWED_AR = new Set(["1:1","16:9","9:16","4:3","3:4","3:2","2:3"]);

function openaiValidateRequest(req: GenerateRequest): void {
  if (req.resolution === "4k") {
    throw new Error("OpenAI provider does not support resolution=4k.");
  }
  if (req.ar && !OPENAI_ALLOWED_AR.has(req.ar)) {
    throw new Error(`OpenAI provider does not support --ar ${req.ar}. Allowed: ${[...OPENAI_ALLOWED_AR].join(", ")}`);
  }
}

// in factory return:
return {
  name: "openai",
  defaultModel: "gpt-image-2",
  validateRequest: openaiValidateRequest,
  generate: generateOnce,
  // ... rest unchanged
};
```

- [ ] **Step 4: Run tests**

Run: `bun test scripts/providers/openai.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/openai.ts scripts/providers/openai.test.ts
git commit -m "refactor(openai): detail passthrough; SIZE_TABLE indexed by resolution; add validateRequest"
```

---

### Task 1.6: Single Migration Commit — drop --quality flag + reject default_quality + reject prompts.json quality + migrate ALL fixtures + commands rename + mask guard + preflight + EXTEND.md.example + README + SKILL.md

**Files:**
- Modify: `scripts/commands/generate.ts`, `scripts/commands/batch.ts`
- Modify: `scripts/lib/args.ts`, `scripts/lib/config.ts` (add quality throws now that fixtures are migrated in same commit)
- Test: `scripts/commands/generate.test.ts`, `scripts/commands/batch.test.ts`, `scripts/lib/args.test.ts`, `scripts/lib/config.test.ts`, `scripts/integration.test.ts` (fixture migration)
- Modify: `EXTEND.md.example`, `README.md`, `SKILL.md`

**Why this is one big commit**: rejecting `--quality` flag, EXTEND.md `default_quality`, and prompts.json `quality` field MUST happen in the same commit that migrates the test fixtures using those forms. Splitting them produces a broken commit (per plan-review P2-1). All breaking flips + all migrations bundled here.

- [ ] **Step 0: Add the three migration throws + import wiring**

`scripts/lib/args.ts`: replace the existing `--quality` parser case with throw:

```ts
import { QUALITY_REMOVED_MSG } from "./config";
// ... in switch ...
case "--quality":
  throw new Error(QUALITY_REMOVED_MSG);
```

`scripts/lib/config.ts`: add throw at top of `mergeConfig`:

```ts
if (extendMd.default_quality !== undefined) {
  throw new Error(QUALITY_REMOVED_MSG);
}
```

`scripts/commands/generate.ts` and `scripts/commands/batch.ts`: in the prompts.json parser, throw on `quality` field:

```ts
import { QUALITY_REMOVED_MSG } from "../lib/config";
// ... when parsing each task object ...
if ("quality" in raw) throw new Error(QUALITY_REMOVED_MSG);
```

- [ ] **Step 1: Write failing tests in `generate.test.ts`**

Add cases:

```ts
describe("generate.ts — quality migration", () => {
  it("throws on prompts.json with quality field", async () => {
    const fixture = '[{"prompt":"x","quality":"2k"}]';
    // ... test that loading this prompts.json throws QUALITY_REMOVED_MSG
    expect(() => loadPromptsFile(fixture)).toThrow(/quality/);
  });
});

describe("generate.ts — preflight 16-image check (post-merge)", () => {
  it("throws when character refs + per-task refs total > 16", async () => {
    // Setup: character profile with 5 refs, prompts.json with 12 task-level refs.
    // Total per task = 17. Should throw before any generate call.
    // (Use mock provider that records calls; assert no calls happened.)
  });

  it("throws when CLI --ref count + editTarget > 16", async () => {
    // 16 --ref + 1 --edit = 17. Should throw before generate.
  });
});

describe("generate.ts — mask + apimart not blocked at command layer", () => {
  it("--provider apimart --mask m.png --ref a.png passes command-layer validation", () => {
    // Mock provider with name="apimart", validateRequest passing.
    // Assert validateProviderCapabilities does not throw (no more provider.name check).
  });

  it("--provider google --mask m.png throws (via google rejectMask, not command layer)", () => {
    // Use real google provider; assert it throws from inside generate, not from validateProviderCapabilities.
  });
});

describe("generate.ts — provider.validateRequest is called for all reqs before main loop", () => {
  it("Nth task with bad ar throws before first generate call", async () => {
    // 3 prompts, 3rd has ar="7:13" rejected by provider.validateRequest.
    // Assert no provider.generate calls happened.
  });
});
```

- [ ] **Step 2: Update `commands/generate.ts`**

Three changes (line numbers per current `main` branch — verify):

1. **Rename `Task` interface fields and `defaults` parameter** (around line 56-88, 122):

```ts
// Replace each occurrence of `quality?: "normal" | "2k"` with:
//   resolution?: "1k" | "2k" | "4k";
//   detail?: "auto" | "low" | "medium" | "high";
// In Task type, defaults parameter, prompts.json parser, and the construction of GenerateRequest.

interface Task {
  prompt: string;
  ar?: string;
  resolution?: "1k" | "2k" | "4k";
  detail?: "auto" | "low" | "medium" | "high";
  ref?: string[];
}
```

2. **Remove `mapQualityToImageSize` import and usage** (around line 161). Replace `imageSize: mapQualityToImageSize(...)` line — just remove it. The `GenerateRequest` no longer has `imageSize`.

The new request build (dual-fill during transition; legacy fields removed in Task 1.7):

```ts
const resolution = (task.resolution ?? config.resolution) as "1k" | "2k" | "4k";
const detail = (task.detail ?? config.detail) as "auto" | "low" | "medium" | "high";
const req: GenerateRequest = {
  prompt: task.prompt,
  model: config.model,
  ar: task.ar ?? config.ar,
  resolution,
  detail,
  // Legacy fields (filled from new; Task 1.7 removes them):
  quality: resolution === "1k" ? "normal" : "2k",
  imageSize: resolution === "1k" ? "1K" : resolution === "2k" ? "2K" : "4K",
  refs: [...mergedRefs],
  editTarget: flags.edit,
  mask: flags.mask,
};
```

3. **Remove old mask guard at line ~42** (current code has `flags.mask && provider.name !== "openai" → throw`). Replace with capability check:

```ts
function validateProviderCapabilities(
  provider: Provider,
  flags: GenerateFlags,
): void {
  if (flags.mask && !flags.edit && (!flags.ref || flags.ref.length === 0)) {
    throw new Error("--mask requires --edit or --ref to specify the image being masked.");
  }
  if (flags.chain && !provider.generateChained) {
    throw new Error(`--chain not supported by provider "${provider.name}".`);
  }
  // No more 16-image check here — moved to post-merge preflight below.
  // No more provider.name === "openai" check — mask is a capability now.
}
```

4. **Add post-merge preflight loop** before the main `for each task` loop:

```ts
const builtReqs: GenerateRequest[] = tasks.map(task => buildRequest(task, flags, config, character));
for (const req of builtReqs) {
  // Post-merge 16-image check (refs + editTarget already merged with character/per-task)
  const totalImages = req.refs.length + (req.editTarget ? 1 : 0);
  if (totalImages > 16) {
    throw new Error(
      `Task with prompt "${req.prompt.slice(0, 40)}..." has ${totalImages} image inputs ` +
      `(refs + editTarget). Maximum is 16.`
    );
  }
  // Provider self-check
  provider.validateRequest?.(req);
}
// Now main loop:
for (const req of builtReqs) {
  await provider.generate(req);
  // ... rest of loop
}
```

5. **Add migration throw in prompts.json parser**: when parsing each task object, if it has a `quality` field, throw `QUALITY_REMOVED_MSG`.

```ts
import { QUALITY_REMOVED_MSG } from "../lib/config";

function parseTask(raw: any): Task {
  if ("quality" in raw) {
    throw new Error(QUALITY_REMOVED_MSG);
  }
  // ... rest of parsing
}
```

- [ ] **Step 3: Update `commands/batch.ts`**

Apply the same field rename (line 21/130/149/151/199): `quality?: "normal" | "2k"` → `resolution?` + `detail?`. Remove `mapQualityToImageSize` usage. Add `quality` field migration throw to its prompts.json parser.

Also: keep `validateBatchTasks` call as-is (existing logic). Add an early check:

```ts
if (subcommand === "submit" && !provider.batchCreate) {
  throw new Error(
    `${provider.name} provider does not support batch. ` +
    `Use 'generate --prompts <file>' for multi-prompt sequential generation.`
  );
}
```

(Although for PR 1, only google + openai are registered; this check is a no-op until apimart lands. Adding it now keeps PR 2 minimal.)

- [ ] **Step 4: Update `EXTEND.md.example`**

Drop `default_model:` line (per plan-review P1-1: shipping a Gemini model name leaks into apimart/openai when users switch `--provider`; per-provider env vars are the recommended override).

Replace contents:

```yaml
---
default_provider: google
default_resolution: 2k
default_detail: high
default_ar: "1:1"
---
```

Note: users who actually need a non-default model should set the per-provider env var (`GOOGLE_IMAGE_MODEL`, `OPENAI_IMAGE_MODEL`, `APIMART_IMAGE_MODEL`) or pass `--model`. The `default_model` field still works in `mergeConfig` (priority unchanged), but stops being a default-shipped recommendation.

- [ ] **Step 5: Update `README.md` migration chapter**

Add a new section after the existing "Capability Matrix":

```markdown
## Migration: --quality → --resolution + --detail

The single `--quality` flag has been split into two independent dimensions to
match what providers actually expose:

- `--resolution {1k,2k,4k}` — output pixel resolution (was: --quality 2k mapped to 2k size)
- `--detail {auto,low,medium,high}` — quality/sharpness tier (was: --quality 2k mapped to "high" detail)

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

Any leftover `quality` field in CLI flags, EXTEND.md, or prompts.json triggers a
clear migration error pointing back to this section.

## EXTEND.md `default_model` advisory (provider-agnostic field)

`default_model` in `EXTEND.md` is **provider-agnostic** and applies regardless of
which `--provider` you select at runtime. With three providers now (`google` / `openai` / `apimart`)
having model-name namespaces that don't overlap (`gemini-3.1-...` vs `gpt-image-2`
vs `gpt-image-2-official`), shipping a default `default_model: gemini-3.1-flash-image-preview`
silently leaks Gemini's model name into apimart and openai paths. As of this release,
`EXTEND.md.example` no longer ships a `default_model:` line.

Recommended override patterns:

| Goal | Mechanism |
|---|---|
| Permanent custom model for one provider | `<PROVIDER>_IMAGE_MODEL` env var (`GOOGLE_IMAGE_MODEL` / `OPENAI_IMAGE_MODEL` / `APIMART_IMAGE_MODEL`) |
| One-off custom model | `--model <id>` CLI flag |
| Permanent custom model across all providers | (rare) keep `default_model` in EXTEND.md, but understand it ignores `--provider` |

Priority order (unchanged): `--model` > `EXTEND.md default_model` > `<PROVIDER>_IMAGE_MODEL` env > provider's built-in default. So an `EXTEND.md default_model` will OVERRIDE per-provider env vars; if you want per-provider env to win, do not set `default_model` in EXTEND.md.
```

- [ ] **Step 6: Update `SKILL.md`**

Apply the same flag examples — replace `--quality 2k` with `--resolution 2k --detail high` in the Usage section.

- [ ] **Step 7: Update existing fixtures**

Search broadly — DO NOT exclude `.test.ts` (per plan-review P1-5; integration.test.ts has live `--quality` / `config.quality` / `imageSize` / `quality:` references):

```bash
rg -n "quality|default_quality|--quality|mapQualityToImageSize|imageSize" \
   scripts README.md SKILL.md EXTEND.md.example
```

Known migration files (verify and update each):

- `scripts/integration.test.ts` — has `--quality`, `config.quality`, `imageSize`, `quality:` literals
- `scripts/commands/generate.test.ts` — fixtures with `quality: "2k"` / `quality: "normal"`
- `scripts/commands/batch.test.ts` — same
- Any `prompts.json` fixture inline in tests

For each fixture, replace:

- `quality: "2k"` → `resolution: "2k", detail: "high"`
- `quality: "normal"` → `resolution: "1k", detail: "medium"`
- `imageSize: "1K"|"2K"|"4K"` → leave for now (commands/* dual-fill in Step 2; final cleanup in Task 1.7)
- `--quality 2k` → `--resolution 2k --detail high`
- `--quality normal` → `--resolution 1k --detail medium`

- [ ] **Step 8: Run all tests**

Run: `bun test`
Expected: PASS (entire suite — PR 1 should leave all tests green).

- [ ] **Step 9: Commit (atomic — stage every modified file from Steps 0–7)**

Per plan-review P3-2: Step 0 modifies `args.ts` and `config.ts` (added throws), and Step 7 migrates fixtures in `args.test.ts` / `config.test.ts`. All must land in this one atomic commit; missing any leaves a broken main.

```bash
git add scripts/lib/args.ts scripts/lib/args.test.ts \
        scripts/lib/config.ts scripts/lib/config.test.ts \
        scripts/commands/generate.ts scripts/commands/batch.ts \
        scripts/commands/generate.test.ts scripts/commands/batch.test.ts \
        scripts/integration.test.ts \
        EXTEND.md.example README.md SKILL.md
git commit -m "refactor(migrate): drop --quality+default_quality+prompts.json quality; rename commands fields; mask capability check; preflight; fixture migration; docs"
```

Verification before committing: `git status --short` should show only the staged paths above (no leftover dirty files). Re-run `bun test` to confirm green.

---

### Task 1.7: Cleanup — Delete Legacy Fields (final PR 1 commit)

**Files:**
- Modify: `scripts/providers/types.ts`, `scripts/lib/config.ts`, `scripts/lib/args.ts`, `scripts/main.ts`
- Modify: `scripts/providers/google.ts`, `scripts/providers/openai.ts`
- Modify: `scripts/commands/generate.ts`, `scripts/commands/batch.ts`
- Modify: corresponding `*.test.ts` files (drop legacy-shape tests)
- Modify: `scripts/integration.test.ts` (Task 1.6 deferred `imageSize:` fixture cleanup here)

By this point all consumers (google.ts, openai.ts, commands/*.ts) read `req.resolution` / `req.detail` directly. They still happen to compile because legacy fields are present and dual-filled, but no consumer **reads** them anymore. This task removes the legacy across the board, including the `main.ts` `quality: args.flags.quality` forwarding pipe added in Task 1.3.

- [ ] **Step 1: Confirm no consumer reads legacy fields**

```bash
rg -n "req\.quality|req\.imageSize|task\.quality|config\.quality|mapQualityToImageSize|flags\.quality|extendMd\.default_quality|quality:|imageSize:|--quality" scripts
```

Expected: zero **read** matches in `scripts/providers/google.ts`, `scripts/providers/openai.ts`, `scripts/commands/generate.ts`, `scripts/commands/batch.ts`, `scripts/main.ts`. Matches in tests / fixtures are expected and listed for deletion in Step 7 (this includes the deferred `imageSize:` literals in `scripts/integration.test.ts` left from Task 1.6).

If any read site still exists, GO BACK to that task and migrate it. **Do not proceed**.

- [ ] **Step 2: Remove legacy fields from `scripts/providers/types.ts`**

```ts
// Final shape:
export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;
  resolution: "1k" | "2k" | "4k";
  detail: "auto" | "low" | "medium" | "high";
  refs: string[];
  editTarget?: string;
  mask?: string;
}
// DELETE: quality, imageSize, mapQualityToImageSize function
```

Also delete the additive shape test in `types.test.ts` that expected old fields; replace with the strict-shape test (the version that has `@ts-expect-error` on `req.quality` / `req.imageSize`).

- [ ] **Step 3: Remove legacy from `scripts/lib/config.ts`**

```ts
// Config interface: remove `quality: "normal" | "2k"`
// mergeConfig: remove `const quality = ... ; ... quality, ...`
```

- [ ] **Step 4: Remove legacy from `scripts/lib/args.ts` and `scripts/main.ts`**

```ts
// ParsedArgs.flags: remove `quality?: string;`
```

In `scripts/main.ts`, also remove `quality: args.flags.quality` from the `resolveConfig` call (added in Task 1.3 Step 4 for legacy compatibility):

```ts
// Before:
const config = resolveConfig({
  model: args.flags.model,
  provider: args.flags.provider,
  ar: args.flags.ar,
  quality: args.flags.quality,        // remove this line in 1.7
  resolution: args.flags.resolution,
  detail: args.flags.detail,
});
// After:
const config = resolveConfig({
  model: args.flags.model,
  provider: args.flags.provider,
  ar: args.flags.ar,
  resolution: args.flags.resolution,
  detail: args.flags.detail,
});
```

- [ ] **Step 5: Remove legacy from `scripts/commands/generate.ts` and `batch.ts`**

In `generate.ts`:
- Remove the dual-fill lines (`quality: resolution === "1k" ? ...`, `imageSize: ...`) from the GenerateRequest construction.
- Remove any `Task.quality?` declaration (no callers set it; PR 1 prompts.json migration throws on `quality` field).

In `batch.ts`:
- Same treatment.

- [ ] **Step 6: Remove dual-fill from any provider that derives or carries legacy**

In `scripts/providers/google.ts`:
- Remove the legacy `imageSize` derivation if it was kept as a defense; google now reads `req.resolution` directly via `deriveGoogleImageSize` helper introduced in Task 1.4 (which itself only reads `req.resolution`).

In `scripts/providers/openai.ts`:
- Verify no remaining `mapToOpenAIQuality` / `req.quality` reference.

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: PASS — all consumers migrated; legacy field removal is clean.

If any failure: it's a fixture that still has `quality:` / `imageSize:` literals. Fix inline, then re-run.

- [ ] **Step 8: Commit**

```bash
git add scripts/providers/types.ts scripts/lib/config.ts scripts/lib/args.ts scripts/main.ts \
        scripts/providers/google.ts scripts/providers/openai.ts \
        scripts/commands/generate.ts scripts/commands/batch.ts \
        scripts/providers/types.test.ts scripts/lib/config.test.ts scripts/lib/args.test.ts \
        scripts/providers/google.test.ts scripts/providers/openai.test.ts \
        scripts/commands/generate.test.ts scripts/commands/batch.test.ts \
        scripts/integration.test.ts
git commit -m "refactor(types/config/args/main/providers/commands): drop legacy quality/imageSize/mapQualityToImageSize"
```

---

- [ ] **Step 10: Push and open PR**

```bash
git fetch origin && git rebase origin/main && git push -u origin refactor/quality-to-resolution-detail
gh pr create --base main --title "refactor: split --quality into --resolution + --detail (abstraction debt)" \
  --body "$(cat <<'EOF'
## Summary

Pure refactor — no functional change. Splits the overloaded `--quality` flag into
two independent dimensions matching what providers actually expose:

- `--resolution {1k,2k,4k}` — pixel resolution (was: --quality 2k → 2k size)
- `--detail {auto,low,medium,high}` — quality/sharpness tier (was: --quality 2k → "high")

Adds optional `Provider.validateRequest` hook and post-merge 16-image preflight.
Removes `mapQualityToImageSize` (Google now derives uppercase `imageSize` internally).

`--quality` removed without alias. Migration is a single throw with full mapping.

## Test plan
- [x] Existing tests pass with renamed flags
- [x] `--quality` throws `QUALITY_REMOVED_MSG` from CLI flag, EXTEND.md, prompts.json
- [x] All 13 ar values parse (but google/openai still throw on the new 6)
- [x] resolution=4k throws at provider level for google + openai
- [x] post-merge 16-image preflight catches character + per-task refs total
- [x] mask + google still throws (via google.rejectMask, not command-layer)
EOF
)"
```

---

## PR 2 — apimart Provider

Once PR 1 is merged into main, create the apimart branch:

```bash
git fetch origin && git checkout -b feat/apimart-provider origin/main
```

### Task 2.1: lib/http.ts — httpGetBytes Raw Helper

**Files:**
- Modify: `scripts/lib/http.ts`
- Test: `scripts/lib/http.test.ts`

- [ ] **Step 1: Write failing test**

Append to `scripts/lib/http.test.ts`:

```ts
describe("httpGetBytes", () => {
  it("returns raw bytes without JSON.parse", async () => {
    // mock fetch to return binary PNG bytes (e.g., the PNG signature 89 50 4e 47 ...)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // ... mock fetch to respond with this Uint8Array as a Response body
    const res = await httpGetBytes("https://example.com/img.png");
    expect(res.status).toBe(200);
    expect(res.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(res.bytes!.slice(0, 8))).toEqual(Array.from(png));
  });

  it("propagates non-200 status without throwing", async () => {
    // mock fetch to return 404
    const res = await httpGetBytes("https://example.com/missing.png");
    expect(res.status).toBe(404);
  });

  it("does not call JSON.parse on body", async () => {
    // mock fetch to return malformed bytes that would throw on JSON.parse
    const malformed = new Uint8Array([0xff, 0xff, 0xff]);
    // assert no exception thrown
    const res = await httpGetBytes("https://example.com/x");
    expect(res.bytes).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test scripts/lib/http.test.ts`
Expected: FAIL — `httpGetBytes` not exported.

- [ ] **Step 3: Implement in `scripts/lib/http.ts`**

Add (placement: near existing `httpGetText`):

```ts
export async function httpGetBytes(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; bytes?: Uint8Array; error?: string }> {
  // Honor the same proxy/curl branch the existing helpers use; consult
  // detectProxy and route through curl if HTTPS_PROXY is set, mirroring httpGetText.
  // Otherwise use fetch().
  try {
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      return { status: res.status, error: await res.text().catch(() => undefined) };
    }
    const buf = await res.arrayBuffer();
    return { status: res.status, bytes: new Uint8Array(buf) };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
```

If the existing `httpGet`/`httpGetText` use a different fetch wrapper or curl branch, replicate that structure (the implementer should read the existing helpers and copy the structural pattern — for example, if they wrap with `withProxy` or a curl fallback, do the same here for `httpGetBytes`).

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test scripts/lib/http.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/http.ts scripts/lib/http.test.ts
git commit -m "feat(http): add httpGetBytes raw helper for binary downloads"
```

---

### Task 2.2: main.ts — Register apimart with Placeholder Factory

**Files:**
- Modify: `scripts/main.ts`

- [ ] **Step 1: Update `scripts/main.ts`**

Add a placeholder import and registration (the real factory comes in Task 2.3):

```ts
// scripts/main.ts (excerpt — additions only)
import { createApimartProvider } from "./providers/apimart";

const PROVIDERS: Record<string, ProviderFactory> = {
  google: createGoogleProvider,
  openai: createOpenAIProvider,
  apimart: createApimartProvider,
};

// In the API key error branch:
if (!config.apiKey) {
  const envName =
    config.provider === "openai" ? "OPENAI_API_KEY"
    : config.provider === "apimart" ? "APIMART_API_KEY"
    : "GOOGLE_API_KEY";
  // ... rest unchanged
}
```

- [ ] **Step 2: Create placeholder `scripts/providers/apimart.ts`**

```ts
// scripts/providers/apimart.ts
import type { Provider, ProviderConfig } from "./types";

export function createApimartProvider(_config: ProviderConfig): Provider {
  return {
    name: "apimart",
    defaultModel: "gpt-image-2-official",
    generate: async () => {
      throw new Error("apimart provider not yet implemented (placeholder)");
    },
  };
}
```

- [ ] **Step 3: Verify it compiles**

Run: `bun test`
Expected: existing tests pass (apimart is registered but not exercised). `bun scripts/main.ts generate --provider apimart --prompt "x"` would throw "not yet implemented" — that's expected.

- [ ] **Step 4: Commit**

```bash
git add scripts/main.ts scripts/providers/apimart.ts
git commit -m "feat(main): register apimart provider with placeholder factory"
```

---

### Task 2.3: apimart.ts — Core (text-only path: validate / submit / poll / download)

**Files:**
- Modify: `scripts/providers/apimart.ts`
- Test: `scripts/providers/apimart.test.ts`

- [ ] **Step 1: Write failing tests in apimart.test.ts**

Create `scripts/providers/apimart.test.ts`:

```ts
import { describe, expect, it, mock } from "bun:test";
import { createApimartProvider } from "./apimart";
import type { Provider } from "./types";

const config = {
  apiKey: "k",
  baseUrl: "https://api.apimart.test",
  model: "gpt-image-2-official",
};

describe("apimart validateRequest", () => {
  const provider = createApimartProvider(config);

  it.each(["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","2:1","1:2","21:9","9:21"])(
    "accepts ar %s at 2k",
    (ar) => {
      expect(() => provider.validateRequest!({
        prompt: "x", model: "gpt-image-2-official",
        ar, resolution: "2k", detail: "high", refs: [],
      })).not.toThrow();
    }
  );

  it("rejects ar 7:13", () => {
    expect(() => provider.validateRequest!({
      prompt: "x", model: "gpt-image-2-official",
      ar: "7:13", resolution: "2k", detail: "high", refs: [],
    })).toThrow();
  });

  it.each(["16:9","9:16","2:1","1:2","21:9","9:21"])(
    "accepts 4k + ar %s",
    (ar) => {
      expect(() => provider.validateRequest!({
        prompt: "x", model: "gpt-image-2-official",
        ar, resolution: "4k", detail: "high", refs: [],
      })).not.toThrow();
    }
  );

  it("rejects 4k + ar 1:1", () => {
    expect(() => provider.validateRequest!({
      prompt: "x", model: "gpt-image-2-official",
      ar: "1:1", resolution: "4k", detail: "high", refs: [],
    })).toThrow(/4k.*1:1|1:1.*4k/i);
  });
});

describe("apimart pollTask state machine", () => {
  it("status union: submitted → in_progress → completed", async () => {
    // mock httpPost (submit) returning task_id
    // mock httpGet (poll) returning sequence: submitted, in_progress, completed
    // assert generate() returns successfully with bytes
  });

  it("status union: pending/processing aliases", async () => {
    // mock poll sequence: pending, processing, completed
    // same assertion
  });

  it("failed + error.message=moderation_blocked → SAFETY", async () => {
    // mock poll: failed with error: { message: "moderation_blocked", type: "...", code: 400 }
    // assert result.finishReason === "SAFETY"
  });

  it("failed + fail_reason=Some random error → ERROR", async () => {
    // mock poll: failed with fail_reason: "internal server"
    // assert result.finishReason === "ERROR"
  });

  it("cancelled → ERROR with reason 'cancelled'", async () => {
    // mock poll: cancelled
    // assert result.finishReason === "ERROR"; safetyInfo.reason contains "cancelled"
  });

  it("timeout → throw with task_id in message", async () => {
    // mock poll: always returns processing; verify throw message contains task_id
  });

  it("submit 401 → throw auth", async () => {
    // mock submit returning 401
    // assert generate() throws with /apimart submit auth failed/
  });

  it("submit 402 → throw insufficient balance", async () => {
    // mock submit returning 402
  });

  it("submit 502 retried → eventually 200", async () => {
    // mock submit: 502, 502, 200 (third attempt)
    // assert generate() succeeds
  });

  it("submit 502 exhausted → throw", async () => {
    // mock submit: 502 four times (exhausts RETRY_DELAYS)
    // assert generate throws with "apimart submit failed"
  });

  it("download 502 retried → 200", async () => {
    // mock download to return 502 once then bytes
    // assert generate() returns the bytes
  });

  it("poll 502 retried → 200 task response", async () => {
    // mock poll: 502 then 200 with completed status
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test scripts/providers/apimart.test.ts`
Expected: FAIL — apimart.ts is still placeholder.

- [ ] **Step 3: Implement core in `scripts/providers/apimart.ts`**

Replace the placeholder with the full text-only implementation:

```ts
import { httpPost, httpGet, httpGetBytes } from "../lib/http";
import type {
  GenerateRequest, GenerateResult, Provider, ProviderConfig,
} from "./types";

const APIMART_ALLOWED_AR = new Set([
  "1:1","16:9","9:16","4:3","3:4","3:2","2:3",
  "5:4","4:5","2:1","1:2","21:9","9:21",
]);
const APIMART_4K_ALLOWED_AR = new Set([
  "16:9","9:16","2:1","1:2","21:9","9:21",
]);

// Production defaults — override via createApimartProvider opts for tests:
const DEFAULT_POLL_INITIAL_WAIT_MS = 12_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000;
const RETRY_DELAYS = [1_000, 2_000, 4_000];
// Shipped impl adds 0: httpGetBytes uses status=0 as the network-failure sentinel
// (httpPost/httpGet use 503 instead), so the download path needs it in the retry set.
const RETRYABLE_STATUS = new Set([0, 429, 500, 502, 503]);
const SAFETY_KEYWORDS = ["moderation","policy","unsafe","safety","block"];

// Per plan-review P1-3: tests need to inject smaller timing values to avoid 180s real-time waits.
// createApimartProvider accepts an optional second arg for testing:
type ApimartProviderOpts = {
  pollInitialMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type NormalizedStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
function normalizeApimartStatus(raw: string): NormalizedStatus {
  switch (raw) {
    case "submitted":
    case "pending":     return "pending";
    case "in_progress":
    case "processing":  return "running";
    case "completed":   return "completed";
    case "failed":      return "failed";
    case "cancelled":   return "cancelled";
    default:            return "pending"; // unknown → keep polling defensively
  }
}

function extractFailReason(data: any): string {
  if (data?.error?.message) {
    const t = data.error.type ? `[${data.error.type}] ` : "";
    return `${t}${data.error.message}`;
  }
  return data?.fail_reason ?? "unknown";
}

// Per plan-review P1-2: HTTP error responses for upload/submit/etc. may have nested
// `{error: {message, code, type}}` (apimart docs) or top-level `{message: ...}`.
// Read both for any 400/error path so safety detection / error reporting doesn't
// silently fall back to "submit error" generic.
function extractHttpErrorMessage(res: { data?: any; error?: any }): string {
  const d = res.data;
  if (d?.error?.message) {
    const t = d.error.type ? `[${d.error.type}] ` : "";
    return `${t}${d.error.message}`;
  }
  if (typeof d?.message === "string") return d.message;
  if (typeof res.error === "string") return res.error;
  return "unknown error";
}

function isSafetyFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return SAFETY_KEYWORDS.some(k => lower.includes(k));
}

function apimartHeaders(apiKey: string): Record<string, string> {
  return { "Authorization": `Bearer ${apiKey}` };
}

function validateApimartRequest(req: GenerateRequest): void {
  if (req.ar && !APIMART_ALLOWED_AR.has(req.ar)) {
    throw new Error(`apimart provider does not support --ar ${req.ar}.`);
  }
  if (req.resolution === "4k" && req.ar && !APIMART_4K_ALLOWED_AR.has(req.ar)) {
    throw new Error(
      `apimart resolution=4k requires --ar one of: ${[...APIMART_4K_ALLOWED_AR].join(", ")}; got ${req.ar}.`
    );
  }
}

type CallResult = { status: number; data?: any; error?: any; bytes?: Uint8Array };

// Per plan-review P2-3: sleep is injected so 502-retry tests don't actually wait RETRY_DELAYS.
async function callWithApimartRetry(
  doCall: () => Promise<CallResult>,
  context: "upload" | "submit" | "poll" | "download",
  opts: { allow400Result?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CallResult> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const res = await doCall();
    if (res.status === 200) return res;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`apimart ${context} auth failed (HTTP ${res.status}): ${(res.data as any)?.message ?? res.error ?? ""}`);
    }
    if (res.status === 402) {
      throw new Error("apimart insufficient balance");
    }
    if (context === "upload" && (res.status === 413 || res.status === 415)) {
      throw new Error(`apimart upload rejected (HTTP ${res.status}): file size > 20MB or unsupported type`);
    }
    if (res.status === 400) {
      if (opts.allow400Result) return res;
      throw new Error(`apimart ${context} bad request (HTTP 400): ${extractHttpErrorMessage(res)}`);
    }
    if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
      throw new Error(`apimart ${context} failed (HTTP ${res.status}): ${extractHttpErrorMessage(res)}`);
    }
    await sleep(RETRY_DELAYS[attempt]);
  }
  throw new Error("Unreachable");
}

function buildApimartPayload(
  req: GenerateRequest,
  imageUrls?: string[],
  maskUrl?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    size: req.ar ?? "1:1",
    resolution: req.resolution,
    quality: req.detail,
    n: 1,
    output_format: "png",
    moderation: "auto",
  };
  if (imageUrls && imageUrls.length > 0) payload.image_urls = imageUrls;
  if (maskUrl) payload.mask_url = maskUrl;
  return payload;
}

interface ResolvedPollOpts {
  initialMs: number;
  intervalMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

async function pollTask(
  baseUrl: string,
  apiKey: string,
  taskId: string,
  opts: ResolvedPollOpts,
  retryOpts: { sleep: (ms: number) => Promise<void> },
): Promise<{ result: GenerateResult } | { error: string; isSafety: boolean }> {
  const headers = apimartHeaders(apiKey);
  const url = `${baseUrl}/v1/tasks/${taskId}`;
  await opts.sleep(opts.initialMs);
  const start = opts.now();
  while (true) {
    const res = await callWithApimartRetry(() => httpGet(url, headers), "poll", retryOpts);
    const data = (res.data as any)?.data;
    const status = normalizeApimartStatus(data?.status ?? "pending");
    if (status === "completed") {
      const images = data?.result?.images ?? [];
      const bytes = await Promise.all(
        images.map(async (img: any) => {
          const dl = await callWithApimartRetry(
            () => httpGetBytes(img.url[0]),
            "download",
            retryOpts,
          );
          return { data: dl.bytes!, mimeType: "image/png" };
        }),
      );
      return { result: { images: bytes, finishReason: "STOP" } };
    }
    if (status === "failed") {
      const reason = extractFailReason(data);
      return { error: reason, isSafety: isSafetyFailure(reason) };
    }
    if (status === "cancelled") {
      return { error: "task cancelled", isSafety: false };
    }
    if (opts.now() - start >= opts.timeoutMs) {
      throw new Error(
        `apimart task polling timeout (>${opts.timeoutMs / 1000}s); task_id=${taskId} ` +
        `(check apimart console; result may still complete and be retrievable manually)`
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}

export function createApimartProvider(
  config: ProviderConfig,
  opts: ApimartProviderOpts = {},
): Provider {
  const { apiKey, baseUrl } = config;
  const headers = apimartHeaders(apiKey);

  // Resolve test-injectable opts once per factory call.
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollOpts: ResolvedPollOpts = {
    initialMs: opts.pollInitialMs ?? DEFAULT_POLL_INITIAL_WAIT_MS,
    intervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    sleep,
    now: opts.now ?? (() => Date.now()),
  };
  // Retry opts passed to every callWithApimartRetry call so 502-retry sleeps are also injectable.
  const retryOpts = { sleep };

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    // Image-input path (refs/editTarget/mask) lands in Task 2.4.
    // For now: text-only.
    if (req.refs.length > 0 || req.editTarget || req.mask) {
      throw new Error("apimart image inputs not yet implemented");
    }
    const payload = buildApimartPayload(req);
    const submitUrl = `${baseUrl}/v1/images/generations`;
    const submitRes = await callWithApimartRetry(
      () => httpPost(submitUrl, payload, headers),
      "submit",
      { allow400Result: true, sleep },
    );
    if (submitRes.status === 400) {
      const reason = extractHttpErrorMessage(submitRes);
      return {
        images: [],
        finishReason: isSafetyFailure(reason) ? "SAFETY" : "ERROR",
        safetyInfo: { reason },
      };
    }
    const taskId = (submitRes.data as any)?.data?.[0]?.task_id;
    if (!taskId) throw new Error("apimart submit response missing task_id");

    const polled = await pollTask(baseUrl, apiKey, taskId, pollOpts, retryOpts);
    if ("error" in polled) {
      return {
        images: [],
        finishReason: polled.isSafety ? "SAFETY" : "ERROR",
        safetyInfo: { reason: polled.error },
      };
    }
    return polled.result;
  }

  return {
    name: "apimart",
    defaultModel: "gpt-image-2-official",
    validateRequest: validateApimartRequest,
    generate,
  };
}
```

**Note for `scripts/main.ts`** (Task 2.2 must be revisited): `main.ts` calls `createApimartProvider(providerConfig)` — that's fine, opts default to production values. Tests in `apimart.test.ts` pass `createApimartProvider(config, { pollInitialMs: 1, pollIntervalMs: 1, pollTimeoutMs: 50, sleep: async () => {}, now: () => mockTime })` to keep test runtime under a second.

Add a test that verifies timing injection works:

```ts
it("pollTask uses injected sleep + now (no real sleep on timeout)", async () => {
  let mockNow = 0;
  const sleeps: number[] = [];
  const provider = createApimartProvider(
    { apiKey: "k", baseUrl: "https://x", model: "gpt-image-2-official" },
    {
      pollInitialMs: 10,
      pollIntervalMs: 5,
      pollTimeoutMs: 50,
      sleep: async (ms) => { sleeps.push(ms); mockNow += ms; },
      now: () => mockNow,
    },
  );
  // mock submit to return task_id; mock poll to always return processing
  // assert generate() throws with task_id in message
  // assert sleeps array shows 10 (initial) followed by multiple 5s (intervals) until total >= 50
  // assert no real time elapsed (process.hrtime delta < 100ms)
});
```

- [ ] **Step 4: Run tests**

Run: `bun test scripts/providers/apimart.test.ts`
Expected: PASS for all text-only and pollTask cases. Image-input cases will fail with "not yet implemented" — that's expected and covered by Task 2.4.

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/apimart.ts scripts/providers/apimart.test.ts
git commit -m "feat(apimart): text-only generate (validate/submit/poll/download); state union; retry helper"
```

---

### Task 2.4: apimart.ts — Image Input Path (Upload + sha256 Cache)

**Files:**
- Modify: `scripts/providers/apimart.ts`
- Modify: `scripts/providers/apimart.test.ts`

- [ ] **Step 1: Add failing tests for image input + cache**

Append to `scripts/providers/apimart.test.ts`:

```ts
describe("apimart image input + sha256 cache", () => {
  it("ref → upload → image_urls passthrough", async () => {
    // mock httpPostMultipart (upload) to return { url: "https://upload.apimart.ai/x" }
    // mock httpPost (submit) — verify request payload contains image_urls = ["https://upload..."]
    // assert generate succeeds
  });

  it("editTarget + refs → editTarget at index 0", async () => {
    // mock upload returns urls in submission order
    // assert payload.image_urls[0] = uploaded(editTarget); image_urls[1..] = uploaded(refs)
  });

  it("mask → mask_url field", async () => {
    // assert payload.mask_url is set; mask URL not in image_urls
  });

  it("cache hit on second sequential call to same hash", async () => {
    // upload mock counts invocations
    // call generate twice with same ref path
    // assert upload mock called once, not twice
  });

  it("cache hit on concurrent calls with same content", async () => {
    // create 2 different paths pointing to same content (same bytes → same sha256)
    // call generate with both refs in same prompt → Promise.all dispatches both uploads concurrently
    // assert upload mock called once
  });

  it("rejected upload clears cache (allows retry)", async () => {
    // upload mock: first call returns 500, exhausts RETRY_DELAYS → throws
    // second call to same hash: upload mock returns 200
    // assert second call succeeds; upload mock called twice
  });

  it("HTTPS_PROXY set → throws before upload", async () => {
    // set process.env.HTTPS_PROXY = "http://proxy"
    // generate with refs
    // assert throws /apimart upload uses multipart upload which is not supported through HTTP proxy/
    // restore env after test
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `bun test scripts/providers/apimart.test.ts`
Expected: FAIL on the image-input cases (they throw "not yet implemented").

- [ ] **Step 3: Add upload + cache to `scripts/providers/apimart.ts`**

```ts
import { basename } from "path";
import { detectProxy, httpPostMultipart } from "../lib/http";

type UploadCache = Map<string, Promise<string>>;

async function fileSha256(localPath: string): Promise<string> {
  const data = await Bun.file(localPath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(data));
  return hasher.digest("hex");
}

function inferMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

function rejectMultipartUnderProxy(operation: string): void {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    throw new Error(
      `apimart ${operation} uses multipart upload which is not supported through HTTP proxy ` +
      `(detected: ${proxy}). Disable the proxy environment variable for this command, ` +
      `or use --provider openai/google for proxy-friendly workflows.`
    );
  }
}

async function doUpload(
  baseUrl: string,
  headers: Record<string, string>,
  localPath: string,
  retryOpts: { sleep: (ms: number) => Promise<void> },
): Promise<string> {
  const buf = await Bun.file(localPath).arrayBuffer();
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buf], { type: inferMimeType(localPath) }),
    basename(localPath),
  );
  const url = `${baseUrl}/v1/uploads/images`;
  const res = await callWithApimartRetry(
    () => httpPostMultipart(url, fd, headers),
    "upload",
    retryOpts,
  );
  const uploadUrl = (res.data as any)?.url;
  if (typeof uploadUrl !== "string") {
    throw new Error(`apimart upload response missing url: ${JSON.stringify(res.data)}`);
  }
  return uploadUrl;
}

async function uploadToApimartCached(
  baseUrl: string,
  headers: Record<string, string>,
  localPath: string,
  cache: UploadCache,
  retryOpts: { sleep: (ms: number) => Promise<void> },
): Promise<string> {
  const hash = await fileSha256(localPath);
  const cached = cache.get(hash);
  if (cached) return await cached;
  // CRITICAL: cache.set BEFORE await, so concurrent same-hash calls hit the in-flight Promise.
  // catch+delete on rejection so future retries can re-attempt.
  const promise = doUpload(baseUrl, headers, localPath, retryOpts).catch((err) => {
    cache.delete(hash);
    throw err;
  });
  cache.set(hash, promise);
  return await promise;
}
```

**Wire into the existing Task 2.3 factory** (do NOT redefine the factory signature — `createApimartProvider(config, opts)` from Task 2.3 stays as-is, including `sleep` / `pollOpts` / `retryOpts`). This step adds:

1. `const uploadCache: UploadCache = new Map();` inside the factory closure (before `generate`)
2. Replaces the "image inputs not yet implemented" early-throw block in `generate` with the upload + cache logic below

```ts
// Inside the existing createApimartProvider(config, opts: ApimartProviderOpts = {}) factory:
//   - keep all existing lines: const { apiKey, baseUrl } = config; const headers = ...;
//     const sleep = ...; const pollOpts = ...; const retryOpts = ...;
//   - ADD this line before `async function generate`:
const uploadCache: UploadCache = new Map();

// REPLACE the "throw not yet implemented" block at the top of generate() with:
async function generate(req: GenerateRequest): Promise<GenerateResult> {
  let imageUrls: string[] | undefined;
  let maskUrl: string | undefined;

  if (req.refs.length > 0 || req.editTarget || req.mask) {
    rejectMultipartUnderProxy("upload");

    // Build upload list with role tracking.
    const uploads: Array<{ path: string; role: "image" | "mask" }> = [];
    if (req.editTarget) uploads.push({ path: req.editTarget, role: "image" });
    for (const ref of req.refs) uploads.push({ path: ref, role: "image" });
    if (req.mask) uploads.push({ path: req.mask, role: "mask" });

    const urls = await Promise.all(
      uploads.map(u => uploadToApimartCached(baseUrl, headers, u.path, uploadCache, retryOpts)),
    );

    imageUrls = uploads
      .map((u, i) => (u.role === "image" ? urls[i] : null))
      .filter((u): u is string => u !== null);
    const maskIdx = uploads.findIndex(u => u.role === "mask");
    maskUrl = maskIdx >= 0 ? urls[maskIdx] : undefined;
  }

  const payload = buildApimartPayload(req, imageUrls, maskUrl);
  // ... rest of generate unchanged from Task 2.3 (submit + poll using pollOpts/retryOpts)
}
// The `return { name, defaultModel, validateRequest, generate }` block at the end of the factory
// stays as it was at the end of Task 2.3 — DO NOT redeclare it here.
```

- [ ] **Step 4: Run tests**

Run: `bun test scripts/providers/apimart.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/providers/apimart.ts scripts/providers/apimart.test.ts
git commit -m "feat(apimart): image-input path with sha256 Promise cache and proxy guard"
```

---

### Task 2.5: commands/* — apimart Wiring (mask allowed, batch refused)

**Files:**
- Modify: `scripts/commands/generate.ts`, `scripts/commands/batch.ts`
- Test: `scripts/commands/generate.test.ts`, `scripts/commands/batch.test.ts`

PR 1 already removed the old mask guard and added the post-merge preflight. PR 2 mostly verifies these work for apimart — minimal code change here, mostly test additions.

- [ ] **Step 1: Add tests for apimart command-layer integration**

In `scripts/commands/generate.test.ts`:

```ts
describe("generate.ts — apimart capability checks", () => {
  it("--provider apimart --mask m.png --ref a.png passes command-layer", async () => {
    // Use mock provider name="apimart" with validateRequest that passes.
    // Assert validateProviderCapabilities does not throw.
  });

  it("--provider apimart --chain throws (no generateChained)", async () => {
    // mock provider apimart with no generateChained
    // flags.chain = true
    // assert throws /chain/
  });

  it("preflight throws for apimart resolution=4k + ar=1:1", async () => {
    // build req with resolution=4k, ar=1:1
    // call provider.validateRequest (real apimart impl from Task 2.3)
    // assert throws /4k.*1:1|1:1.*4k/i before any generate
  });
});
```

In `scripts/commands/batch.test.ts`:

```ts
describe("batch.ts — apimart batch refused", () => {
  it("submit → friendly throw", async () => {
    // call runBatch with subcommand="submit" and provider=apimart (no batchCreate)
    // assert throws /apimart provider does not support batch/
  });

  it("status/fetch/list/cancel → friendly throw", async () => {
    // each subcommand should throw the same friendly message
  });
});
```

- [ ] **Step 2: Run tests to verify failures or pass**

Run: `bun test scripts/commands/generate.test.ts scripts/commands/batch.test.ts`
Expected: PASS for the apimart cases (PR 1 already wired the necessary changes). If any fail, the issue is in PR 1's command-layer logic — fix in this task.

- [ ] **Step 3: Commit (only if changes were needed)**

```bash
git add scripts/commands/generate.ts scripts/commands/batch.ts \
        scripts/commands/generate.test.ts scripts/commands/batch.test.ts
git commit -m "test(commands): apimart capability checks (mask allowed, chain/batch refused)"
```

If no changes were needed: skip this commit step.

---

### Task 2.6: Documentation + Integration Test

**Files:**
- Modify: `README.md`, `SKILL.md`
- Modify: `scripts/integration.test.ts`

- [ ] **Step 1: Update `README.md` apimart chapter**

Add a new section after the existing OpenAI section:

```markdown
## apimart Provider (China gateway)

apimart is a China-domestic gateway for OpenAI gpt-image-2 with native 4K, extended
aspect ratios (13 values total), and a fully async task model.

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

# 4K (only 16:9, 9:16, 2:1, 1:2, 21:9, 9:21)
bun scripts/main.ts generate --provider apimart --prompt "..." --resolution 4k --ar 16:9

# Image-to-image (auto-uploads to apimart, returns 72h URL)
bun scripts/main.ts generate --provider apimart --prompt "..." --ref a.png

# Edit with mask
bun scripts/main.ts generate --provider apimart --prompt "..." --edit photo.png --mask m.png
```

### Notes

- **HTTPS_PROXY**: apimart upload uses multipart and does NOT route through HTTP proxy
  (same constraint as OpenAI direct). Disable proxy when using `--provider apimart` with
  image inputs.
- **Async polling**: image generation is async (submit → poll). Polling uses 12s initial
  wait, 3s interval, 180s timeout. On timeout, the error message includes `task_id` —
  check the apimart console manually if the task subsequently completes.
- **Image upload URLs**: refs/edit/mask are uploaded to apimart's own
  `/v1/uploads/images` endpoint and return URLs valid for 72h. apimart manages
  expiration; jdy-imagine does NOT need cleanup steps. URLs are reused across the
  same run via sha256-keyed cache.
- **No batch / no chain**: `apimart` does not implement batch (no cost benefit) or chain
  (API is async/stateless). These commands throw with a friendly message pointing to
  alternatives.
```

Update the existing capability matrix to include the apimart column.

- [ ] **Step 2: Update `SKILL.md`**

Update the `description` field to mention three providers, and add the apimart usage examples to the Usage section.

- [ ] **Step 3: Add apimart e2e to `scripts/integration.test.ts`**

Append:

```ts
describe("integration: apimart e2e", () => {
  it("text-to-image: submit → poll → download", async () => {
    // mock fetch: submit returns task_id; poll returns processing twice then completed; download returns PNG bytes
    // run main.ts with --provider apimart --prompt "..."
    // assert output file written
  });

  it("image-to-image: upload + submit + poll + download", async () => {
    // mock fetch: upload returns URL; submit returns task_id; poll completed; download bytes
    // assert output written; uploaded URL appeared in submit payload's image_urls[0]
  });

  it("character profile + 10 prompts → cache deduplicates uploads", async () => {
    // character has 5 refs (different paths but maybe overlapping content)
    // prompts has 10 prompts
    // assert upload mock called exactly N (N = unique sha256 hashes), not 50
  });

  it("failed-safety: returns SAFETY result without throwing", async () => {
    // mock poll: failed with error.message="moderation_blocked"
    // assert main.ts exit code 0 (or whatever the error path is) and result.finishReason=SAFETY
  });

  it("timeout: throws with task_id", async () => {
    // mock poll: always processing for >180s simulated time
    // assert throw message contains "task_id="
  });

  it("cancelled: returns ERROR with reason 'cancelled'", async () => {
    // mock poll: cancelled
    // assert finishReason=ERROR
  });
});
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md SKILL.md scripts/integration.test.ts
git commit -m "docs(apimart): three-provider matrix; setup + usage + integration e2e"
```

- [ ] **Step 6: Push and open PR**

```bash
git fetch origin && git rebase origin/main && git push -u origin feat/apimart-provider
gh pr create --base main --title "feat: apimart provider (China gpt-image-2 gateway, 4K, 13-ar)" \
  --body "$(cat <<'EOF'
## Summary

Adds a third image-generation provider `apimart` covering capabilities not in google/openai:
- China-domestic gateway (no cross-border proxy needed)
- 4K output (6 aspect ratios)
- 13-value aspect ratio set (adds 5:4, 4:5, 2:1, 1:2, 21:9, 9:21)
- Async task model with auto-upload via apimart's own `/v1/uploads/images`
  (72h URLs, no R2 / wrangler / external image host needed)

Image inputs deduplicated via sha256-keyed run-scoped Promise cache (same content
uploads exactly once even with concurrent paths). All four endpoint paths
(upload/submit/poll/download) share a provider-local retry helper with
RETRYABLE_STATUS={429,500,502,503} (the shared `lib/http` retry set is
{429,500,503} and is intentionally not reused).

## Test plan

- [x] Text-to-image roundtrip
- [x] Image-to-image: upload + submit + poll + download
- [x] sha256 cache deduplication (sequential + concurrent)
- [x] Rejected upload clears cache; retry succeeds
- [x] Status union: submitted/in_progress and pending/processing aliases
- [x] Failure paths: SAFETY (moderation), ERROR (other), cancelled (ERROR with reason)
- [x] Timeout includes task_id in error
- [x] HTTPS_PROXY rejected with friendly fallback message
- [x] Capability matrix: apimart column documented; mask allowed; batch/chain refused
EOF
)"
```

---

## Self-Review

(Author's checklist run on completion of this plan.)

**1. Spec coverage:**
- Spec §1 architecture (data flow, file change table, module boundaries) → covered by File Structure table + Tasks 1.1–2.6
- Spec §2 data structures (types/config/args/prompts.json) → Tasks 1.1, 1.2, 1.3, 1.6
- Spec §3.1 generate flow (apimart text + image paths) → Tasks 2.3, 2.4
- Spec §3.2 batch refusal → Task 2.5
- Spec §3.3 chain refusal → already covered by existing `generateChained` check (PR 1 preserves it)
- Spec §3.4 error mapping → Task 2.3 (state machine + extractFailReason + isSafetyFailure)
- Spec §3.5 fail-fast preflight → Task 1.6 (post-merge preflight + provider.validateRequest invocation)
- Spec §3.6 upload pseudo-code → Task 2.4
- Spec §3.7 capability matrix → Task 2.6 (README/SKILL update)
- Spec §4 testing strategy → tests embedded in each Task
- Spec §5 PR ordering → matches PR 1 / PR 2 split here
- Spec Risks → covered implicitly (timeout task_id message, no resume, multipart proxy guard, default detail=high, cache catch+delete)

**2. Placeholder scan:** No "TBD", "TODO", or "implement later" in any task body. Step 3 of Task 2.1 mentions "implementer should read existing helpers and copy structural pattern" — this is the **only** non-literal step and is justified because the existing http.ts proxy/curl branch is too long to inline; the task explicitly points to `httpGetText` as the reference shape.

**3. Type consistency:** `validateRequest`, `callWithApimartRetry`, `uploadToApimartCached`, `UploadCache`, `normalizeApimartStatus`, `extractFailReason`, `isSafetyFailure`, `QUALITY_REMOVED_MSG` — all names referenced in later tasks match the definitions in earlier tasks. `mapToOpenAISize` signature change from `quality` to `resolution` is consistent across Task 1.5 test and implementation.
