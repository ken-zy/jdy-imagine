import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseArgs } from "./lib/args";
import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs } from "./lib/character";
import { generateSlug, buildOutputPath, nextSeqNumber } from "./lib/output";
import { parseExtendMd, parseDotEnv, mergeConfig } from "./lib/config";
import { buildRealtimeRequestBody, parseGenerateResponse } from "./providers/google";
import { validateGenerateArgs, loadPrompts } from "./commands/generate";
import { saveManifest, loadManifest } from "./commands/batch";

describe("Integration: CLI -> provider -> output pipeline", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "jdy-imagine-int-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("full pipeline: args -> config -> request -> response -> output", () => {
    // 1. Parse args
    const args = parseArgs([
      "generate",
      "--prompt", "A sunset over mountains",
      "--ar", "16:9",
      "--resolution", "2k",
      "--detail", "high",
      "--outdir", tempDir,
    ]);
    expect(args.command).toBe("generate");

    // 2. Merge config
    const config = mergeConfig(
      {
        model: args.flags.model,
        ar: args.flags.ar,
        resolution: args.flags.resolution,
        detail: args.flags.detail,
      },
      {},
      { GOOGLE_API_KEY: "test-key" },
    );
    expect(config.model).toBe("gemini-3.1-flash-image-preview");
    expect(config.resolution).toBe("2k");
    expect(config.detail).toBe("high");

    // 3. Build request
    const req = buildRealtimeRequestBody({
      prompt: args.flags.prompt!,
      model: config.model,
      ar: args.flags.ar ?? config.ar,
      resolution: config.resolution,
      detail: config.detail,
      refs: [],
    });
    expect(req.contents[0].parts[0].text).toContain("A sunset");

    // 4. Parse a mock response
    const mockApiResponse = {
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              data: Buffer.from("fake-png-data").toString("base64"),
              mimeType: "image/png",
            },
          }],
        },
        finishReason: "STOP",
      }],
    };
    const result = parseGenerateResponse(mockApiResponse);
    expect(result.images).toHaveLength(1);

    // 5. Generate slug and output path
    const slug = generateSlug(args.flags.prompt!);
    expect(slug).toBe("a-sunset-over-mountains");
    const seq = nextSeqNumber(tempDir);
    const outPath = buildOutputPath(tempDir, slug, seq);
    expect(outPath).toContain("001-a-sunset-over-mountains.png");
  });

  test("batch manifest round-trip", () => {
    const manifest = {
      jobId: "batches/test123",
      model: "gemini-3.1-flash-image-preview",
      createTime: "2026-04-13T10:00:00Z",
      outdir: tempDir,
      tasks: [
        { key: "001-sunset", prompt: "A sunset" },
        { key: "002-cat", prompt: "A cat" },
      ],
    };
    saveManifest(tempDir, manifest);
    const loaded = loadManifest(tempDir, "batches/test123");
    expect(loaded).not.toBeNull();
    expect(loaded!.tasks).toHaveLength(2);
  });

  test("prompts.json loading and validation", () => {
    const promptsFile = join(tempDir, "test-prompts.json");
    writeFileSync(promptsFile, JSON.stringify([
      { "prompt": "A sunset", "ar": "16:9" },
      { "prompt": "A cat portrait" },
    ]));

    const tasks = loadPrompts(
      { prompts: promptsFile },
      { model: "test", ar: "1:1", resolution: "2k", detail: "high", refs: [] },
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].ar).toBe("16:9");
    expect(tasks[1].ar).toBe("1:1");
  });
});

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
      resolution: "1k", detail: "medium" as const,
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
        provider: "fake", model: "fake", resolution: "1k", detail: "medium" as const,
        ar: "1:1", apiKey: "fake", baseUrl: "http://fake",
      }, {
        prompts: promptsPath, outdir: dir, json: true, chain: true,
      });
    } catch { /* ignore */ }
    process.exit = originalExit;
    expect(exitCode).toBe(1);
  });
});

describe("integration: OpenAI provider", () => {
  test("generate text-to-image end-to-end (mocked)", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-openai-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      if (url.toString().includes("/v1/images/generations")) {
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from("FAKE-PNG").toString("base64") }],
        }), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as typeof fetch;
    try {
      const { runGenerate } = await import("./commands/generate");
      const { createOpenAIProvider } = await import("./providers/openai");
      const provider = createOpenAIProvider({
        apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2",
      });
      await runGenerate(provider, {
        provider: "openai", model: "gpt-image-2", resolution: "1k", detail: "medium", ar: "1:1",
        apiKey: "k", baseUrl: "https://api.openai.com",
      }, {
        prompt: "test cat", outdir: tmpOut, json: false,
      });
      const files = (await Bun.$`ls ${tmpOut}/`.text()).trim().split("\n").filter(f => f.endsWith(".png"));
      expect(files.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("edit with mask end-to-end (mocked)", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-openai-edit-"));
    const editFile = join(tmpOut, "edit.png");
    const maskFile = join(tmpOut, "mask.png");
    await Bun.write(editFile, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    await Bun.write(maskFile, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (url: any) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("PNG").toString("base64") }],
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const { runGenerate } = await import("./commands/generate");
      const { createOpenAIProvider } = await import("./providers/openai");
      const provider = createOpenAIProvider({
        apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2",
      });
      await runGenerate(provider, {
        provider: "openai", model: "gpt-image-2", resolution: "1k", detail: "medium", ar: "1:1",
        apiKey: "k", baseUrl: "https://api.openai.com",
      }, {
        prompt: "edit", edit: editFile, mask: maskFile, outdir: tmpOut, json: false,
      });
      expect(capturedUrl).toContain("/v1/images/edits");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("batch submit/poll/fetch end-to-end (mocked)", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-openai-batch-"));
    const promptsFile = join(tmpOut, "prompts.json");
    writeFileSync(promptsFile, JSON.stringify([
      { prompt: "cat" },
      { prompt: "dog" },
    ]));
    const jsonlOutput =
      JSON.stringify({ custom_id: "001-cat", response: { body: { data: [{ b64_json: Buffer.from("CAT").toString("base64") }] } } }) + "\n" +
      JSON.stringify({ custom_id: "002-dog", response: { body: { data: [{ b64_json: Buffer.from("DOG").toString("base64") }] } } }) + "\n";
    let pollCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any = {}) => {
      const u = url.toString();
      const method = init.method ?? "GET";
      if (u.endsWith("/v1/files") && method === "POST") {
        return new Response(JSON.stringify({ id: "file_in" }), { status: 200 });
      }
      if (u.endsWith("/v1/batches") && method === "POST") {
        return new Response(JSON.stringify({
          id: "batch_int", status: "validating", created_at: 1000,
        }), { status: 200 });
      }
      if (u.includes("/v1/batches/batch_int") && !u.includes("/cancel") && method === "GET") {
        pollCount++;
        const status = pollCount >= 2 ? "completed" : "in_progress";
        return new Response(JSON.stringify({
          id: "batch_int", status, created_at: 1000,
          output_file_id: "file_out",
          request_counts: { total: 2, completed: 2, failed: 0 },
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_out/content")) {
        return new Response(jsonlOutput, { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as typeof fetch;
    try {
      const { runBatch } = await import("./commands/batch");
      const { createOpenAIProvider } = await import("./providers/openai");
      const provider = createOpenAIProvider({
        apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2",
      });
      await runBatch(provider, {
        provider: "openai", model: "gpt-image-2", resolution: "1k", detail: "medium", ar: "1:1",
        apiKey: "k", baseUrl: "https://api.openai.com",
      }, {
        command: "batch", subcommand: "submit", positional: promptsFile,
        flags: { outdir: tmpOut, json: false, async: false, chain: false },
      } as any);
      const files = (await Bun.$`ls ${tmpOut}/`.text()).trim().split("\n").filter(f => f.endsWith(".png"));
      expect(files.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("integration: apimart provider", () => {
  const apimartConfig = {
    provider: "apimart" as const,
    model: "gpt-image-2-official",
    resolution: "2k" as const,
    detail: "high" as const,
    ar: "16:9",
    apiKey: "k",
    baseUrl: "https://api.apimart.test",
  };
  const fastOpts = {
    pollInitialMs: 0,
    pollIntervalMs: 0,
    pollTimeoutMs: 5000,
    sleep: async () => {},
    now: () => 0,
  };

  test("text-to-image: submit → poll → download", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-apimart-text-"));
    let pollCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "task-int-1" }] }), { status: 200 });
      }
      if (url.endsWith("/v1/tasks/task-int-1")) {
        pollCount++;
        if (pollCount === 1) return new Response(JSON.stringify({ data: { status: "processing" } }), { status: 200 });
        return new Response(JSON.stringify({
          data: { status: "completed", result: { images: [{ url: ["https://cdn.apimart/img.png"] }] } },
        }), { status: 200 });
      }
      if (url === "https://cdn.apimart/img.png") {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as typeof fetch;
    try {
      const { runGenerate } = await import("./commands/generate");
      const { createApimartProvider } = await import("./providers/apimart");
      const provider = createApimartProvider(apimartConfig, fastOpts);
      await runGenerate(provider, apimartConfig, {
        prompt: "a cyberpunk skyline",
        outdir: tmpOut,
        json: false,
      });
      const files = (await Bun.$`ls ${tmpOut}/`.text()).trim().split("\n").filter(f => f.endsWith(".png"));
      expect(files.length).toBe(1);
      expect(pollCount).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("image-to-image: upload + submit + poll + download (URL routed via image_urls[0])", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-apimart-i2i-"));
    const refPath = join(tmpOut, "ref.png");
    await Bun.write(refPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]));
    let submitBody: any;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const req = new Request(input, init);
      if (req.url.endsWith("/v1/uploads/images")) {
        const fd = await req.formData();
        const file = fd.get("file") as File;
        return new Response(JSON.stringify({ url: `https://upload.apimart/${file.name}` }), { status: 200 });
      }
      if (req.url.endsWith("/v1/images/generations")) {
        submitBody = await req.json();
        return new Response(JSON.stringify({ data: [{ task_id: "t-i2i" }] }), { status: 200 });
      }
      if (req.url.includes("/v1/tasks/")) {
        return new Response(JSON.stringify({
          data: { status: "completed", result: { images: [{ url: "https://cdn.apimart/out.png" }] } },
        }), { status: 200 });
      }
      return new Response(new Uint8Array([0x89, 0x50]), { status: 200 });
    }) as typeof fetch;
    try {
      const { runGenerate } = await import("./commands/generate");
      const { createApimartProvider } = await import("./providers/apimart");
      const provider = createApimartProvider(apimartConfig, fastOpts);
      await runGenerate(provider, apimartConfig, {
        prompt: "make it golden",
        ref: [refPath],
        outdir: tmpOut,
        json: false,
      });
      expect(submitBody.image_urls).toEqual(["https://upload.apimart/ref.png"]);
      expect(submitBody.mask_url).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("character profile + 4 prompts: cache deduplicates uploads to N unique hashes", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-apimart-char-"));
    // Two character refs (unique hashes) — the runtime cache should upload each once even
    // across all 4 prompts (4 × 2 = 8 ref-paths, but only 2 unique sha256 hashes).
    const refA = join(tmpOut, "char-a.png");
    const refB = join(tmpOut, "char-b.png");
    await Bun.write(refA, new Uint8Array([1, 2, 3, 4, 5]));
    await Bun.write(refB, new Uint8Array([6, 7, 8, 9, 10]));
    const characterPath = join(tmpOut, "character.json");
    writeFileSync(characterPath, JSON.stringify({
      name: "Hero",
      description: "wearing a red cape",
      negative: "modern clothing",
      references: [refA, refB],
    }));
    const promptsPath = join(tmpOut, "prompts.json");
    writeFileSync(promptsPath, JSON.stringify([
      { prompt: "scene 1" },
      { prompt: "scene 2" },
      { prompt: "scene 3" },
      { prompt: "scene 4" },
    ]));
    let uploadCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const req = new Request(input, init);
      if (req.url.endsWith("/v1/uploads/images")) {
        uploadCount++;
        const fd = await req.formData();
        const file = fd.get("file") as File;
        return new Response(JSON.stringify({ url: `https://upload.apimart/${file.name}` }), { status: 200 });
      }
      if (req.url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: `t-${Math.random()}` }] }), { status: 200 });
      }
      if (req.url.includes("/v1/tasks/")) {
        return new Response(JSON.stringify({
          data: { status: "completed", result: { images: [{ url: "https://cdn.apimart/o.png" }] } },
        }), { status: 200 });
      }
      return new Response(new Uint8Array([0x89, 0x50]), { status: 200 });
    }) as typeof fetch;
    try {
      const { runGenerate } = await import("./commands/generate");
      const { createApimartProvider } = await import("./providers/apimart");
      const provider = createApimartProvider(apimartConfig, fastOpts);
      await runGenerate(provider, apimartConfig, {
        prompts: promptsPath,
        character: characterPath,
        outdir: tmpOut,
        json: false,
      });
      // 2 unique character refs × 4 prompts = 8 upload requests if the cache failed; the
      // sha256 cache should compress this to exactly 2 (one per unique hash).
      expect(uploadCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("failed-safety: poll returns SAFETY result without throwing", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-apimart-safety-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t-safety" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { status: "failed", error: { message: "moderation_blocked", type: "policy_violation", code: 400 } },
      }), { status: 200 });
    }) as typeof fetch;
    const originalExit = process.exit;
    let exitCode = 0;
    process.exit = ((code: number) => { exitCode = code; throw new Error("exited"); }) as any;
    try {
      const { runGenerate } = await import("./commands/generate");
      const { createApimartProvider } = await import("./providers/apimart");
      const provider = createApimartProvider(apimartConfig, fastOpts);
      try {
        await runGenerate(provider, apimartConfig, {
          prompt: "blocked content",
          outdir: tmpOut,
          json: true,
        });
      } catch { /* runGenerate calls process.exit on safety, which our stub re-throws */ }
      expect(exitCode).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      process.exit = originalExit;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("timeout: throws with task_id in message", async () => {
    const tmpOut = mkdtempSync(join(tmpdir(), "jdy-int-apimart-timeout-"));
    let mockTime = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "task-frozen" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "processing" } }), { status: 200 });
    }) as typeof fetch;
    try {
      const { createApimartProvider } = await import("./providers/apimart");
      const provider = createApimartProvider(apimartConfig, {
        pollInitialMs: 1, pollIntervalMs: 1, pollTimeoutMs: 50,
        sleep: async (ms) => { mockTime += ms; },
        now: () => mockTime,
      });
      await expect(provider.generate({
        prompt: "x", model: "gpt-image-2-official", ar: "16:9",
        resolution: "2k", detail: "high", refs: [],
      })).rejects.toThrow(/task_id=task-frozen/);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test("cancelled: returns ERROR with reason 'cancelled'", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t-cancel" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "cancelled" } }), { status: 200 });
    }) as typeof fetch;
    try {
      const { createApimartProvider } = await import("./providers/apimart");
      const provider = createApimartProvider(apimartConfig, fastOpts);
      const result = await provider.generate({
        prompt: "x", model: "gpt-image-2-official", ar: "16:9",
        resolution: "2k", detail: "high", refs: [],
      });
      expect(result.finishReason).toBe("ERROR");
      expect(result.safetyInfo?.reason).toContain("cancelled");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
