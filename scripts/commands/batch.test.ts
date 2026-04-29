import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { saveManifest, loadManifest, writeResults, BATCH_PAYLOAD_LIMIT, type BatchManifest } from "./batch";
import type { BatchResult } from "../providers/types";

describe("saveManifest", () => {
  test("persists manifest to .jdy-imagine-batch dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    const manifest: BatchManifest = {
      jobId: "batches/abc123",
      model: "gemini-3.1-flash-image-preview",
      createTime: "2026-04-13T10:00:00Z",
      outdir: dir,
      tasks: [
        { key: "001-sunset", prompt: "A sunset over mountains", ar: "16:9" },
      ],
    };

    saveManifest(dir, manifest);

    const manifestDir = join(dir, ".jdy-imagine-batch");
    expect(existsSync(manifestDir)).toBe(true);

    const files = readdirSync(manifestDir).filter(f => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });
});

describe("loadManifest", () => {
  test("loads saved manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    const manifest: BatchManifest = {
      jobId: "batches/abc123",
      model: "test-model",
      createTime: "2026-04-13T10:00:00Z",
      outdir: dir,
      tasks: [{ key: "001-cat", prompt: "A cat" }],
    };

    saveManifest(dir, manifest);
    const loaded = loadManifest(dir, "batches/abc123");
    expect(loaded).not.toBeNull();
    expect(loaded!.jobId).toBe("batches/abc123");
    expect(loaded!.tasks).toHaveLength(1);
  });

  test("returns null for missing manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    expect(loadManifest(dir, "batches/missing")).toBeNull();
  });
});

describe("writeResults", () => {
  test("multi-image results get -a, -b suffixes", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    const results: BatchResult[] = [
      {
        key: "001-cat",
        result: {
          images: [
            { data: new Uint8Array([1]), mimeType: "image/png" },
            { data: new Uint8Array([2]), mimeType: "image/png" },
          ],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-cat-a.png"))).toBe(true);
    expect(existsSync(join(dir, "001-cat-b.png"))).toBe(true);
  });

  test("JPEG mimeType produces .jpg extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    const results: BatchResult[] = [
      {
        key: "001-photo",
        result: {
          images: [{ data: new Uint8Array([1]), mimeType: "image/jpeg" }],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-photo.jpg"))).toBe(true);
  });

  test("collision handling avoids overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    writeFileSync(join(dir, "001-cat.png"), "existing");
    const results: BatchResult[] = [
      {
        key: "001-cat",
        result: {
          images: [{ data: new Uint8Array([1]), mimeType: "image/png" }],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-cat-2.png"))).toBe(true);
  });
});

describe("payload estimation", () => {
  test("payload limit is 100MB for file-based input", () => {
    expect(BATCH_PAYLOAD_LIMIT).toBe(100 * 1024 * 1024);
  });

  test("payload limit is not the old 20MB inline limit", () => {
    expect(BATCH_PAYLOAD_LIMIT).toBeGreaterThan(20 * 1024 * 1024);
  });
});

import { validateBatchTasks, runBatch } from "./batch";
import type { GenerateRequest, Provider } from "../providers/types";
import type { Config } from "../lib/config";
import type { ParsedArgs } from "../lib/args";

describe("validateBatchTasks for OpenAI", () => {
  test("text-only tasks pass", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, resolution: "1k", detail: "medium", refs: [] },
    ])).not.toThrow();
  });

  test("tasks with refs throw", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, resolution: "1k", detail: "medium", refs: ["/tmp/a.png"] },
    ])).toThrow(/text-only/i);
  });

  test("tasks with editTarget throw", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, resolution: "1k", detail: "medium", refs: [], editTarget: "/tmp/e.png" },
    ])).toThrow(/text-only/i);
  });

  test("tasks with mask throw", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, resolution: "1k", detail: "medium", refs: [], mask: "/tmp/m.png" },
    ])).toThrow(/text-only/i);
  });

  test("error message mentions character profile", () => {
    expect(() => validateBatchTasks("openai", [
      { prompt: "x", model: "m", ar: null, resolution: "1k", detail: "medium", refs: ["/tmp/a.png"] },
    ])).toThrow(/character/i);
  });

  test("google provider unaffected by validateBatchTasks", () => {
    expect(() => validateBatchTasks("google", [
      { prompt: "x", model: "m", ar: null, resolution: "1k", detail: "medium", refs: ["/tmp/a.png"] },
    ])).not.toThrow();
  });
});

describe("batch refuses apimart with friendly message", () => {
  function apimartProvider(): Provider {
    return {
      name: "apimart",
      defaultModel: "gpt-image-2-official",
      generate: async () => ({ images: [], finishReason: "STOP" as const }),
      // No batchCreate / batchGet / batchFetch / batchList / batchCancel — apimart
      // intentionally doesn't ship batch (no cost benefit; submit/poll is async anyway).
    };
  }

  function configFor(): Config {
    return {
      provider: "apimart",
      model: "gpt-image-2-official",
      resolution: "2k",
      detail: "high",
      ar: "1:1",
      apiKey: "k",
      baseUrl: "https://api.apimart.test",
    };
  }

  function args(sub: string, positional?: string): ParsedArgs {
    return {
      command: "batch",
      subcommand: sub,
      positional,
      flags: { outdir: ".", json: false, async: false, chain: false },
    };
  }

  test("submit → throws does-not-support", async () => {
    await expect(runBatch(apimartProvider(), configFor(), args("submit", "p.json"))).rejects.toThrow(
      /apimart does not support batch/i,
    );
  });

  test("status → throws", async () => {
    await expect(runBatch(apimartProvider(), configFor(), args("status", "task-x"))).rejects.toThrow(
      /does not support batch/i,
    );
  });

  test("fetch → throws", async () => {
    await expect(runBatch(apimartProvider(), configFor(), args("fetch", "task-x"))).rejects.toThrow(
      /does not support batch/i,
    );
  });

  test("list → throws", async () => {
    await expect(runBatch(apimartProvider(), configFor(), args("list"))).rejects.toThrow(
      /does not support batch/i,
    );
  });

  test("cancel → throws", async () => {
    await expect(runBatch(apimartProvider(), configFor(), args("cancel", "task-x"))).rejects.toThrow(
      /does not support batch/i,
    );
  });
});

describe("batchSubmit calls provider.validateRequest", () => {
  function setup(opts: { tasks: unknown[]; validateRequest?: (req: GenerateRequest) => void }): {
    provider: Provider;
    config: Config;
    args: ParsedArgs;
  } {
    const dir = mkdtempSync(join(tmpdir(), "batch-validate-"));
    const promptsPath = join(dir, "prompts.json");
    writeFileSync(promptsPath, JSON.stringify(opts.tasks));
    const provider: Provider = {
      name: "fake",
      defaultModel: "fake-model",
      validateRequest: opts.validateRequest,
      generate: async () => ({ images: [], finishReason: "STOP" as const }),
      batchCreate: async () => ({
        id: "batches/fake",
        state: "running" as const,
        createTime: "2026-04-29T00:00:00Z",
      }),
      batchGet: async () => ({
        id: "batches/fake",
        state: "succeeded" as const,
        createTime: "2026-04-29T00:00:00Z",
      }),
      batchFetch: async () => [],
    };
    const config: Config = {
      provider: "fake",
      model: "fake-model",
      resolution: "2k",
      detail: "high",
      ar: "1:1",
      apiKey: "k",
      baseUrl: "https://fake",
    };
    const args: ParsedArgs = {
      command: "batch",
      subcommand: "submit",
      positional: promptsPath,
      flags: { outdir: dir, json: false, async: true, chain: false },
    };
    return { provider, config, args };
  }

  test("validateRequest is invoked for every task in batch submit", async () => {
    const seen: string[] = [];
    const { provider, config, args } = setup({
      tasks: [
        { prompt: "a" },
        { prompt: "b" },
      ],
      validateRequest: (req) => {
        seen.push(req.prompt);
      },
    });
    await runBatch(provider, config, args);
    expect(seen).toEqual(["a", "b"]);
  });

  test("validateRequest throw aborts batch submit before batchCreate", async () => {
    let batchCreateCalled = false;
    const { provider, config, args } = setup({
      tasks: [{ prompt: "x", ar: "5:4" }],
      validateRequest: () => {
        throw new Error("provider rejects ar=5:4");
      },
    });
    provider.batchCreate = async () => {
      batchCreateCalled = true;
      return { id: "x", state: "running" as const, createTime: "" };
    };
    await expect(runBatch(provider, config, args)).rejects.toThrow(/ar=5:4/);
    expect(batchCreateCalled).toBe(false);
  });

  test("provider without validateRequest still submits", async () => {
    const { provider, config, args } = setup({ tasks: [{ prompt: "x" }] });
    delete (provider as Partial<Provider>).validateRequest;
    await expect(runBatch(provider, config, args)).resolves.toBeUndefined();
  });
});
