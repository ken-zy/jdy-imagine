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
      "--quality", "2k",
      "--outdir", tempDir,
    ]);
    expect(args.command).toBe("generate");

    // 2. Merge config
    const config = mergeConfig(
      { model: args.flags.model, ar: args.flags.ar, quality: args.flags.quality },
      {},
      { GOOGLE_API_KEY: "test-key" },
    );
    expect(config.model).toBe("gemini-3.1-flash-image-preview");

    // 3. Build request
    const req = buildRealtimeRequestBody({
      prompt: args.flags.prompt!,
      model: config.model,
      ar: args.flags.ar ?? config.ar,
      quality: config.quality,
      refs: [],
      imageSize: "2K",
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
      { model: "test", ar: "1:1", quality: "2k", refs: [] },
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
