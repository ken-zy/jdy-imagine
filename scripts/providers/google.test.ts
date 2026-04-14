import { describe, test, expect } from "bun:test";
import {
  buildRealtimeRequestBody,
  parseGenerateResponse,
  mapQualityToImageSize,
  buildBatchRequestBody,
  parseBatchResponse,
  validateBatchTasks,
  buildChainedRequestBody,
  createGoogleAnchor,
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
    expect(anchor.firstUserParts).toHaveLength(1);
    expect((anchor.firstUserParts[0] as any).text).toContain("first prompt");
    expect(anchor.modelContent.role).toBe("model");
    expect(anchor.modelContent.parts).toHaveLength(3);
    expect((anchor.modelContent.parts[0] as any).thoughtSignature).toBe("sig1");
  });
});
