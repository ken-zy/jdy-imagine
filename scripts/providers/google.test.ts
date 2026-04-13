import { describe, test, expect } from "bun:test";
import {
  buildRealtimeRequestBody,
  parseGenerateResponse,
  mapQualityToImageSize,
  buildBatchRequestBody,
  parseBatchResponse,
  validateBatchTasks,
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

  test("rejects tasks with refs", () => {
    const tasks = [
      { prompt: "Edit this", model: "test", ar: null, quality: "2k" as const, refs: ["a.png"], imageSize: "2K" as const },
    ];
    expect(() => validateBatchTasks(tasks)).toThrow("Batch mode does not support reference images in v0.1");
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
