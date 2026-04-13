import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseArgs } from "./lib/args";
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
