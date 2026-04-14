import { describe, test, expect, mock, afterEach } from "bun:test";
import {
  buildRealtimeRequestBody,
  parseGenerateResponse,
  mapQualityToImageSize,
  buildBatchRequestBody,
  parseBatchResponse,
  validateBatchTasks,
  buildChainedRequestBody,
  createGoogleAnchor,
  buildBatchJsonl,
  parseJsonlResultLine,
  createGoogleProvider,
} from "./google";

describe("mapQualityToImageSize", () => {
  test("normal -> 1K", () => {
    expect(mapQualityToImageSize("normal")).toBe("1K");
  });

  test("2k -> 2K", () => {
    expect(mapQualityToImageSize("2k")).toBe("2K");
  });
});

describe("buildRealtimeRequestBody", () => {
  test("text-only prompt without refs", () => {
    const body = buildRealtimeRequestBody({
      prompt: "A cat",
      model: "gemini-3.1-flash-image-preview",
      ar: "16:9",
      quality: "2k",
      refs: [],
      imageSize: "2K",
    });
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts).toHaveLength(1);
    expect(body.contents[0].parts[0].text).toContain("A cat");
    expect(body.contents[0].parts[0].text).toContain("Aspect ratio: 16:9");
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
    expect(body.generationConfig.imageConfig.imageSize).toBe("2K");
  });

  test("no aspect ratio -> no AR in prompt text", () => {
    const body = buildRealtimeRequestBody({
      prompt: "A cat",
      model: "test",
      ar: null,
      quality: "2k",
      refs: [],
      imageSize: "2K",
    });
    expect(body.contents[0].parts[0].text).not.toContain("Aspect ratio");
  });
});

describe("parseGenerateResponse", () => {
  test("parses successful single image response", () => {
    const apiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from("fake-image").toString("base64"),
                  mimeType: "image/png",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.finishReason).toBe("STOP");
  });

  test("parses safety-blocked response", () => {
    const apiResponse = {
      candidates: [
        {
          content: { parts: [] },
          finishReason: "SAFETY",
          safetyRatings: [
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              probability: "HIGH",
            },
          ],
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(0);
    expect(result.finishReason).toBe("SAFETY");
    expect(result.safetyInfo).toBeDefined();
  });

  test("parses multi-image response", () => {
    const apiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: Buffer.from("img1").toString("base64"),
                  mimeType: "image/png",
                },
              },
              { text: "Here are the images" },
              {
                inlineData: {
                  data: Buffer.from("img2").toString("base64"),
                  mimeType: "image/jpeg",
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(2);
    expect(result.textParts).toEqual(["Here are the images"]);
  });

  test("parses text-only response (no images)", () => {
    const apiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "I cannot generate that image" }],
          },
          finishReason: "STOP",
        },
      ],
    };
    const result = parseGenerateResponse(apiResponse);
    expect(result.images).toHaveLength(0);
    expect(result.finishReason).toBe("STOP");
    expect(result.textParts).toEqual(["I cannot generate that image"]);
  });
});

describe("validateBatchTasks", () => {
  test("passes for text-only tasks", () => {
    const tasks = [
      { prompt: "A cat", model: "test", ar: null, quality: "2k" as const, refs: [], imageSize: "2K" as const },
    ];
    expect(() => validateBatchTasks(tasks)).not.toThrow();
  });

  test("accepts tasks with refs", () => {
    const tasks = [
      { prompt: "Edit this", model: "test", ar: null, quality: "2k" as const, refs: ["a.png"], imageSize: "2K" as const },
    ];
    expect(() => validateBatchTasks(tasks)).not.toThrow();
  });
});

describe("buildBatchRequestBody", () => {
  test("builds inline batch request", () => {
    const body = buildBatchRequestBody(
      "gemini-3.1-flash-image-preview",
      [
        { prompt: "A sunset", model: "test", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" },
      ],
      "test-batch",
    );
    expect(body.batch.display_name).toBe("test-batch");
    expect(body.batch.input_config.requests.requests).toHaveLength(1);
    const req = body.batch.input_config.requests.requests[0];
    expect(req.metadata.key).toMatch(/^001-/);
  });

  test("inlines ref images as base64 in batch request", () => {
    // Create a temp ref image
    const { mkdtempSync, writeFileSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-ref-"));
    const refPath = join(dir, "ref.png");
    writeFileSync(refPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes

    const body = buildBatchRequestBody(
      "gemini-3.1-flash-image-preview",
      [
        { prompt: "Make it blue", model: "test", ar: null, quality: "2k", refs: [refPath], imageSize: "2K" },
      ],
      "test-batch",
    );

    const parts = body.batch.input_config.requests.requests[0].request.contents[0].parts;
    // First part should be inlineData (ref image), second should be text
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveProperty("inlineData");
    expect((parts[0] as any).inlineData.mimeType).toBe("image/png");
    expect(parts[1]).toHaveProperty("text");
    expect((parts[1] as any).text).toBe("Make it blue");
  });
});

describe("parseBatchResponse", () => {
  test("parses inline batch results", () => {
    const apiResponse = {
      inlinedResponses: [
        {
          metadata: { key: "001-cat" },
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from("img").toString("base64"),
                        mimeType: "image/png",
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      ],
    };
    const results = parseBatchResponse(apiResponse);
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("001-cat");
    expect(results[0].result?.images).toHaveLength(1);
  });

  test("handles batch item errors", () => {
    const apiResponse = {
      inlinedResponses: [
        {
          metadata: { key: "001-fail" },
          response: {
            error: { message: "Content blocked" },
          },
        },
      ],
    };
    const results = parseBatchResponse(apiResponse);
    expect(results[0].error).toBe("Content blocked");
  });
});

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
    expect(anchor).not.toBeNull();
    expect(anchor!.firstUserParts).toHaveLength(1);
    expect((anchor!.firstUserParts[0] as any).text).toContain("first prompt");
    expect(anchor!.modelContent.role).toBe("model");
    expect(anchor!.modelContent.parts).toHaveLength(3);
    expect((anchor!.modelContent.parts[0] as any).thoughtSignature).toBe("sig1");
  });

  test("returns null when SAFETY block has no model content", () => {
    const firstReq = {
      prompt: "blocked prompt",
      model: "test",
      ar: null as string | null,
      quality: "2k" as const,
      refs: [],
      imageSize: "2K" as const,
    };

    // SAFETY response: candidate exists but no content
    const rawResponse = {
      candidates: [
        {
          finishReason: "SAFETY",
          safetyRatings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH" }],
        },
      ],
    };

    const anchor = createGoogleAnchor(firstReq, rawResponse);
    expect(anchor).toBeNull();
  });
});

describe("buildBatchJsonl", () => {
  test("produces valid JSONL with correct keys", () => {
    const { data, keys } = buildBatchJsonl(
      "gemini-3.1-flash-image-preview",
      [
        { prompt: "A sunset over mountains", model: "test", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" },
        { prompt: "A cat sleeping", model: "test", ar: null, quality: "normal", refs: [], imageSize: "1K" },
      ],
      "test-batch",
    );

    const text = new TextDecoder().decode(data);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);

    const line1 = JSON.parse(lines[0]);
    const line2 = JSON.parse(lines[1]);

    expect(line1.key).toMatch(/^001-/);
    expect(line2.key).toMatch(/^002-/);
    expect(keys).toEqual([line1.key, line2.key]);

    expect(line1.request.contents[0].parts).toBeDefined();
    expect(line1.request.generationConfig.responseModalities).toEqual(["IMAGE"]);
    expect(line1.request.generationConfig.imageConfig.imageSize).toBe("2K");
    expect(line2.request.generationConfig.imageConfig.imageSize).toBe("1K");
  });

  test("includes aspect ratio in prompt text", () => {
    const { data } = buildBatchJsonl(
      "test-model",
      [{ prompt: "A cat", model: "test", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" }],
      "test",
    );

    const line = JSON.parse(new TextDecoder().decode(data).trim());
    const textPart = line.request.contents[0].parts.find((p: any) => p.text);
    expect(textPart.text).toContain("Aspect ratio: 16:9");
  });

  test("inlines ref images as base64", () => {
    const { mkdtempSync, writeFileSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");
    const dir = mkdtempSync(join(tmpdir(), "jsonl-ref-"));
    const refPath = join(dir, "ref.png");
    writeFileSync(refPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { data } = buildBatchJsonl(
      "test-model",
      [{ prompt: "Edit this", model: "test", ar: null, quality: "2k", refs: [refPath], imageSize: "2K" }],
      "test",
    );

    const line = JSON.parse(new TextDecoder().decode(data).trim());
    const parts = line.request.contents[0].parts;
    expect(parts[0]).toHaveProperty("inlineData");
    expect(parts[0].inlineData.mimeType).toBe("image/png");
    expect(parts[1]).toHaveProperty("text");
  });

  test("returns Uint8Array with trailing newline", () => {
    const { data } = buildBatchJsonl(
      "test-model",
      [{ prompt: "A cat", model: "test", ar: null, quality: "normal", refs: [], imageSize: "1K" }],
      "test",
    );
    const text = new TextDecoder().decode(data);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("parseJsonlResultLine", () => {
  test("parses successful result line", () => {
    const line = JSON.stringify({
      key: "001-cat",
      response: {
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                data: Buffer.from("img").toString("base64"),
                mimeType: "image/png",
              },
            }],
          },
          finishReason: "STOP",
        }],
      },
    });

    const result = parseJsonlResultLine(line);
    expect(result).not.toBeNull();
    expect(result!.key).toBe("001-cat");
    expect(result!.result?.images).toHaveLength(1);
  });

  test("parses error result line", () => {
    const line = JSON.stringify({
      key: "002-fail",
      error: { message: "Content blocked" },
    });

    const result = parseJsonlResultLine(line);
    expect(result).not.toBeNull();
    expect(result!.key).toBe("002-fail");
    expect(result!.error).toBe("Content blocked");
  });

  test("returns null for malformed JSON", () => {
    const result = parseJsonlResultLine("not-json{{{");
    expect(result).toBeNull();
  });

  test("returns null for empty line", () => {
    const result = parseJsonlResultLine("");
    expect(result).toBeNull();
  });

  test("handles line with response.error (API error)", () => {
    const line = JSON.stringify({
      key: "003-err",
      response: {
        error: { message: "Internal error" },
      },
    });

    const result = parseJsonlResultLine(line);
    expect(result!.key).toBe("003-err");
    expect(result!.error).toBe("Internal error");
  });
});

describe("batchFetch (file-based)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("downloads JSONL and parses results", async () => {
    const jsonlContent = [
      JSON.stringify({ key: "001-cat", response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img1").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] } }),
      JSON.stringify({ key: "002-dog", response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img2").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] } }),
    ].join("\n") + "\n";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // batchGet — full job response
      if (url.includes("batches/job1") && !url.includes("/download/")) {
        return new Response(JSON.stringify({
          name: "batches/job1",
          metadata: { state: "JOB_STATE_SUCCEEDED", totalCount: 2, succeededCount: 2, failedCount: 0 },
          response: { responsesFile: "files/output456" },
        }), { status: 200 });
      }

      // downloadJsonl
      if (url.includes("/download/")) {
        return new Response(jsonlContent, { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const results = await provider.batchFetch!("batches/job1");

    expect(results).toHaveLength(2);
    expect(results[0].key).toBe("001-cat");
    expect(results[0].result?.images).toHaveLength(1);
    expect(results[1].key).toBe("002-dog");
  });

  test("falls back to inlinedResponses for old inline jobs", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("batches/old-job")) {
        return new Response(JSON.stringify({
          name: "batches/old-job",
          metadata: { state: "JOB_STATE_SUCCEEDED" },
          response: {
            inlinedResponses: [{
              metadata: { key: "001-cat" },
              response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] },
            }],
          },
        }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const results = await provider.batchFetch!("batches/old-job");

    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("001-cat");
  });

  test("warns when result count differs from stats.total", async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };

    const jsonlContent = JSON.stringify({ key: "001-cat", response: { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from("img").toString("base64"), mimeType: "image/png" } }] }, finishReason: "STOP" }] } }) + "\n";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (!url.includes("/download/")) {
        return new Response(JSON.stringify({
          name: "batches/job1",
          metadata: { state: "JOB_STATE_SUCCEEDED", totalCount: 3, succeededCount: 3, failedCount: 0 },
          response: { responsesFile: "files/output456" },
        }), { status: 200 });
      }

      return new Response(jsonlContent, { status: 200 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const results = await provider.batchFetch!("batches/job1");

    expect(results).toHaveLength(1);
    expect(errors.some(e => e.includes("Expected 3 results, got 1"))).toBe(true);

    console.error = originalError;
  });
});

describe("batchCreate (file-based)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uploads JSONL then creates batch with file_name", async () => {
    const capturedUrls: string[] = [];
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedUrls.push(url);

      // Files API: resumable start
      if (url.includes("/upload/v1beta/files")) {
        return new Response(null, {
          status: 200,
          headers: { "x-goog-upload-url": "https://upload.example.com/finalize" },
        });
      }

      // Files API: upload finalize
      if (url.includes("upload.example.com/finalize")) {
        return new Response(JSON.stringify({ file: { name: "files/input789" } }), { status: 200 });
      }

      // Batch create
      if (url.includes(":batchGenerateContent")) {
        if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({
          name: "batches/job1",
          metadata: { state: "JOB_STATE_PENDING", createTime: "2026-04-14T00:00:00Z" },
        }), { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const job = await provider.batchCreate!({
      model: "gemini-3.1-flash-image-preview",
      tasks: [{ prompt: "A cat", model: "test", ar: null, quality: "normal", refs: [], imageSize: "1K" }],
    });

    expect(job.id).toBe("batches/job1");
    expect(job.state).toBe("pending");

    // Verify batch create body uses file_name, NOT inline requests
    const batchBody = capturedBodies[0] as any;
    expect(batchBody.batch.input_config.file_name).toBe("files/input789");
    expect(batchBody.batch.input_config.requests).toBeUndefined();
  });
});

describe("batchGet (file-based)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("extracts responsesFile from succeeded job", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        name: "batches/job1",
        metadata: {
          state: "JOB_STATE_SUCCEEDED",
          createTime: "2026-04-14T00:00:00Z",
          totalCount: 4,
          succeededCount: 4,
          failedCount: 0,
        },
        response: {
          responsesFile: "files/output456",
        },
      }), { status: 200 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const job = await provider.batchGet!("batches/job1");

    expect(job.state).toBe("succeeded");
    expect(job.responsesFile).toBe("files/output456");
    expect(job.stats?.total).toBe(4);
  });

  test("returns undefined responsesFile for pending job", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        name: "batches/job1",
        metadata: { state: "JOB_STATE_PENDING", createTime: "2026-04-14T00:00:00Z" },
      }), { status: 200 });
    }) as typeof fetch;

    const provider = createGoogleProvider("fake-key", "https://generativelanguage.googleapis.com");
    const job = await provider.batchGet!("batches/job1");

    expect(job.state).toBe("pending");
    expect(job.responsesFile).toBeUndefined();
  });
});
